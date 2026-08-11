// Camada de conexao WebRTC P2P entre os dois peers da sala. So troca SDP/ICE
// pelo canal de sinalizacao ja existente (signaling-client.js) - o arquivo em
// si vai direto pelo RTCDataChannel aberto aqui, sem passar pelo servidor
// (transferencia de fato acontece em file-transfer.js, etapa 3).
//
// origin (celular) sempre inicia a oferta: cria o RTCDataChannel e manda o
// offer assim que o websocket de sinalizacao abre. dest (computador) fica
// passivo esperando o offer chegar - na pratica dest sempre conecta no ws
// primeiro (a pagina so mostra o QR depois disso), entao o offer nunca chega
// antes de dest estar escutando.
//
// iceServers vem de fora (ice-config.js, etapa 4) - STUN publico sempre,
// TURN efemero quando o servidor tiver credenciais configuradas. Sem
// TURN, so conecta quando ha caminho direto entre os dois peers (mesma
// rede ou NAT simples) - o fallback default aqui cobre esse caso mesmo
// se quem chamar esquecer de passar iceServers.

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export function createPeerConnection({
  isInitiator,
  sendSignal,
  onDataChannel,
  onStateChange,
  iceServers,
  iceTransportPolicy,
}) {
  const pc = new RTCPeerConnection({
    iceServers: iceServers ?? DEFAULT_ICE_SERVERS,
    ...(iceTransportPolicy ? { iceTransportPolicy } : {}),
  });
  const pendingCandidates = [];
  let remoteDescriptionSet = false;

  pc.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) sendSignal({ type: "ice-candidate", candidate: ev.candidate.toJSON() });
  });

  pc.addEventListener("connectionstatechange", () => {
    onStateChange?.(pc.connectionState);
  });

  if (isInitiator) {
    const channel = pc.createDataChannel("file");
    channel.binaryType = "arraybuffer";
    onDataChannel?.(channel);
  } else {
    pc.addEventListener("datachannel", (ev) => {
      ev.channel.binaryType = "arraybuffer";
      onDataChannel?.(ev.channel);
    });
  }

  async function applyRemoteDescription(sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    remoteDescriptionSet = true;
    while (pendingCandidates.length) {
      await pc.addIceCandidate(pendingCandidates.shift()).catch(() => {});
    }
  }

  async function handleSignal(msg) {
    if (msg.type === "offer") {
      await applyRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", sdp: pc.localDescription });
    } else if (msg.type === "answer") {
      await applyRemoteDescription(msg.sdp);
    } else if (msg.type === "ice-candidate") {
      const candidate = new RTCIceCandidate(msg.candidate);
      if (remoteDescriptionSet) await pc.addIceCandidate(candidate).catch(() => {});
      else pendingCandidates.push(candidate);
    }
  }

  async function startOffer() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", sdp: pc.localDescription });
  }

  return { pc, handleSignal, startOffer };
}
