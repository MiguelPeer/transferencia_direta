import { parseSignalingMessage } from "./security.js";

const OTHER_ROLE = { origin: "dest", dest: "origin" };

// Relay puro de metadado entre os dois peers de uma sala. O servidor nunca
// interpreta SDP/ICE, so encaminha - e nunca ve bytes de arquivo (isso vai
// direto entre os peers via RTCDataChannel, ou via TURN em bytes opacos).
export function handleConnection(ws, { token, role, roomManager, log }) {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const other = () => roomManager.get(token)?.peers.get(OTHER_ROLE[role]);

  ws.send(JSON.stringify({ type: "joined", role, token }));
  other()?.send(JSON.stringify({ type: "peer-status", status: "connected" }));

  ws.on("message", (raw) => {
    const msg = parseSignalingMessage(raw);
    if (!msg) {
      ws.close(4001, "invalid_message");
      return;
    }

    if (msg.type === "download-confirmed") {
      const downloadsLeft = roomManager.registerDownload(token);
      const payload = JSON.stringify({ type: "downloads-left", downloadsLeft });
      ws.send(payload);
      other()?.send(payload);
      return;
    }

    if (msg.type === "destroy") {
      log?.(`sala ${token} destruida por ${role}`);
      roomManager.destroy(token, "destroyed_by_user");
      return;
    }

    // offer / answer / ice-candidate: repassa como veio pro outro peer
    other()?.send(JSON.stringify(msg));
  });

  ws.on("close", () => {
    other()?.send(JSON.stringify({ type: "peer-status", status: "disconnected" }));
    roomManager.detach(token, role);
  });
}
