import crypto from "node:crypto";

// Estado da sala vive so em memoria: nada aqui toca disco ou banco.
// Cada sala expira sozinha (TTL) e tambem morre quando o download
// e confirmado + destruido, ou quando os dois peers somem.

const ROOM_TTL_MS = 10 * 60 * 1000; // sala nao reclamada expira em 10min
const CONNECTED_TTL_MS = 30 * 60 * 1000; // teto de vida apos os 2 peers conectarem
const MAX_DOWNLOADS_DEFAULT = 3;
const ROLES = new Set(["origin", "dest"]); // origin = celular (envia), dest = computador (recebe)

export class RoomManager {
  #rooms = new Map();

  create({ maxDownloads = MAX_DOWNLOADS_DEFAULT } = {}) {
    const token = crypto.randomBytes(16).toString("base64url"); // ~128 bits, imprevisivel
    const room = {
      token,
      createdAt: Date.now(),
      status: "waiting", // waiting -> connected -> destroyed
      maxDownloads,
      downloadsLeft: maxDownloads,
      peers: new Map(), // role -> ws
      timer: null,
    };
    room.timer = setTimeout(() => this.destroy(token, "expired"), ROOM_TTL_MS);
    this.#rooms.set(token, room);
    return room;
  }

  get(token) {
    return this.#rooms.get(token);
  }

  isRoleTaken(token, role) {
    const room = this.get(token);
    return Boolean(room?.peers.get(role));
  }

  attach(token, role, ws) {
    if (!ROLES.has(role)) throw new Error("invalid_role");
    const room = this.get(token);
    if (!room || room.status === "destroyed") throw new Error("room_not_found");
    if (room.peers.has(role)) throw new Error("role_taken");

    room.peers.set(role, ws);

    if (room.peers.size === ROLES.size) {
      room.status = "connected";
      clearTimeout(room.timer);
      // uma vez conectados, a sala ainda tem um teto de vida absoluto
      room.timer = setTimeout(() => this.destroy(token, "expired"), CONNECTED_TTL_MS);
    }
    return room;
  }

  detach(token, role) {
    const room = this.get(token);
    if (!room) return;
    room.peers.delete(role);
    // sem os dois peers a sala nao serve mais pra nada
    this.destroy(token, "peer_left");
  }

  registerDownload(token) {
    const room = this.get(token);
    if (!room) return null;
    room.downloadsLeft = Math.max(0, room.downloadsLeft - 1);
    if (room.downloadsLeft === 0) this.destroy(token, "downloads_exhausted");
    return room.downloadsLeft;
  }

  destroy(token, reason = "manual") {
    const room = this.#rooms.get(token);
    if (!room || room.status === "destroyed") return;
    room.status = "destroyed";
    clearTimeout(room.timer);
    for (const ws of room.peers.values()) {
      try {
        ws.send(JSON.stringify({ type: "room-destroyed", reason }));
        ws.close(4000, reason);
      } catch {
        // peer ja desconectado, ignora
      }
    }
    room.peers.clear();
    this.#rooms.delete(token);
  }

  get size() {
    return this.#rooms.size;
  }
}
