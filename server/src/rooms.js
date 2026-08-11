import crypto from "node:crypto";

// Estado da sala vive so em memoria: nada aqui toca disco ou banco.
// Cada sala expira sozinha (TTL) e tambem morre quando o download
// e confirmado + destruido, ou quando os dois peers somem.

const ROOM_TTL_MS = 10 * 60 * 1000; // sala nao reclamada expira em 10min
const CONNECTED_TTL_MS = 30 * 60 * 1000; // teto de vida apos os 2 peers conectarem
const MAX_DOWNLOADS_DEFAULT = 3;
const ROLES = new Set(["origin", "dest"]); // origin = quem envia, dest = quem recebe (nao amarrado a tipo de aparelho)
const OTHER_ROLE = { origin: "dest", dest: "origin" };

// Alfabeto do codigo de sala ditavel por telefone: sem 0/O/1/I, que se
// confundem por voz ou em teclados diferentes.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export class RoomManager {
  #rooms = new Map();
  #byCode = new Map(); // code -> token, resolucao O(1) pra entrada digitada

  #generateCode() {
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
    } while (this.#byCode.has(code));
    return code;
  }

  // role = papel que quem esta abrindo a sala escolheu ("origin" envia,
  // "dest" recebe). Quem entrar depois (via QR ou codigo) herda o
  // complemento automaticamente - ver getByCode/get + creatorRole.
  create({ role, maxDownloads = MAX_DOWNLOADS_DEFAULT } = {}) {
    if (!ROLES.has(role)) throw new Error("invalid_role");
    const token = crypto.randomBytes(16).toString("base64url"); // ~128 bits, imprevisivel - o QR usa isso
    const code = this.#generateCode(); // curto, so pra digitacao manual - nao substitui o token
    const room = {
      token,
      code,
      creatorRole: role,
      createdAt: Date.now(),
      status: "waiting", // waiting -> connected -> destroyed
      maxDownloads,
      downloadsLeft: maxDownloads,
      peers: new Map(), // role -> ws
      timer: null,
    };
    room.timer = setTimeout(() => this.destroy(token, "expired"), ROOM_TTL_MS);
    this.#rooms.set(token, room);
    this.#byCode.set(code, token);
    return room;
  }

  get(token) {
    return this.#rooms.get(token);
  }

  getByCode(code) {
    const token = this.#byCode.get(code.toUpperCase());
    return token ? this.get(token) : undefined;
  }

  // papel que quem ainda vai entrar na sala deve assumir - sempre o
  // complemento de quem abriu.
  joinRole(token) {
    const room = this.get(token);
    return room ? OTHER_ROLE[room.creatorRole] : undefined;
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
    this.#byCode.delete(room.code);
  }

  get size() {
    return this.#rooms.size;
  }
}
