// Monta a lista de ICE servers pro RTCPeerConnection: STUN publico sempre
// (descoberta de IP, cobre a maior parte dos NATs sozinho), mais TURN
// efemero quando o servidor tiver credenciais configuradas (server/src/turn.js).
// Sem TURN configurado, /api/turn-credentials responde 204 e cai pra STUN-only
// - so conecta quando ha caminho direto entre os dois peers (mesma rede ou
// NAT simples). O navegador tenta candidatos diretos primeiro por prioridade
// ICE e so usa o relay TURN quando precisa - nao e preciso escolher entre um
// ou outro aqui.

const STUN_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export async function loadIceServers() {
  try {
    const res = await fetch("/api/turn-credentials");
    if (res.status !== 200) return STUN_SERVERS;
    const creds = await res.json();
    return [...STUN_SERVERS, { urls: creds.urls, username: creds.username, credential: creds.credential }];
  } catch {
    return STUN_SERVERS;
  }
}
