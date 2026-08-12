// Cliente fino do WS de sinalizacao. So metadado de conexao passa por aqui -
// nunca bytes de arquivo (isso vai direto pelo RTCDataChannel/P2P).
export function connectSignaling({ token, role, onMessage, onOpen, onClose }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&role=${role}`);

  ws.addEventListener("open", () => onOpen?.());
  ws.addEventListener("close", (ev) => onClose?.(ev));
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage?.(msg);
  });

  return ws;
}
