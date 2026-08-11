import { connectSignaling } from "/assets/signaling-client.js";
import { createPeerConnection } from "/assets/webrtc-client.js";
import { createFileReceiver } from "/assets/file-transfer.js";
import { loadIceServers } from "/assets/ice-config.js";

const dot = document.getElementById("dot");
const eyebrowText = document.getElementById("eyebrowText");
const qrBox = document.getElementById("qrBox");
const qrLabel = document.getElementById("qrLabel");
const tokenLabel = document.getElementById("tokenLabel");
const statusText = document.getElementById("statusText");
const qrWrap = document.getElementById("qrWrap");
const transfer = document.getElementById("transfer");
const transferName = document.getElementById("transferName");
const progressFill = document.getElementById("progressFill");
const transferPct = document.getElementById("transferPct");
const received = document.getElementById("received");
const receivedName = document.getElementById("receivedName");
const receivedHint = document.getElementById("receivedHint");
const downloadBtn = document.getElementById("downloadBtn");

const SIGNAL_TYPES = new Set(["offer", "answer", "ice-candidate"]);

function showPanel(el) {
  for (const panel of [qrWrap, transfer, received]) {
    panel.style.display = panel === el ? "flex" : "none";
  }
}

function setProgress(receivedBytes, total) {
  const pct = total > 0 ? Math.round((receivedBytes / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  transferPct.textContent = `${pct}%`;
}

async function createRoom() {
  const [res, iceServers] = await Promise.all([fetch("/api/rooms", { method: "POST" }), loadIceServers()]);
  if (!res.ok) {
    statusText.textContent = "falha ao criar sala — recarregue a página";
    dot.classList.add("off");
    return;
  }
  const room = await res.json();
  tokenLabel.textContent = room.token.slice(0, 8);

  const qrRes = await fetch(room.qrUrl);
  const svg = await qrRes.text();
  qrBox.innerHTML = svg;
  qrLabel.textContent = "aponte a câmera para conectar";
  eyebrowText.textContent = "aguardando celular";

  let peer = null;

  const ws = connectSignaling({
    token: room.token,
    role: "dest",
    onOpen: () => {
      statusText.textContent = "sala ativa — aguardando conexão";
      peer = createPeerConnection({
        isInitiator: false,
        iceServers,
        sendSignal: (msg) => ws.send(JSON.stringify(msg)),
        onDataChannel: (channel) => {
          const handleMessage = createFileReceiver({
            onMeta: (meta) => {
              transferName.textContent = meta.name;
              setProgress(0, meta.size);
              showPanel(transfer);
              statusText.textContent = "recebendo arquivo…";
            },
            onProgress: (recv, total) => setProgress(recv, total),
            onComplete: ({ blob, name }) => {
              statusText.textContent = "arquivo recebido";
              receivedName.textContent = name;
              receivedHint.textContent = "integridade confirmada — hash sha-256 conferido";
              showPanel(received);

              const url = URL.createObjectURL(blob);
              downloadBtn.onclick = () => {
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                a.click();
                ws.send(JSON.stringify({ type: "download-confirmed" }));
                downloadBtn.disabled = true;
                downloadBtn.textContent = "baixado";
              };
            },
            onError: (reason) => {
              const isMismatch = reason === "integrity_mismatch";
              statusText.textContent = isMismatch ? "falha de integridade — arquivo corrompido" : "falha ao receber arquivo";
              receivedName.textContent = "—";
              receivedHint.textContent = isMismatch
                ? "o hash recebido não confere — tente enviar de novo"
                : reason;
              showPanel(received);
              downloadBtn.disabled = true;
            },
          });
          channel.addEventListener("message", (ev) => handleMessage(ev.data));
          channel.addEventListener("open", () => {
            statusText.textContent = "canal direto pronto para receber";
          });
          channel.addEventListener("close", () => {
            statusText.textContent = "canal direto fechado";
          });
        },
        onStateChange: (state) => {
          if (state === "connecting") statusText.textContent = "estabelecendo canal direto…";
          if (state === "failed" || state === "disconnected") {
            statusText.textContent = "falha no canal direto — mesma rede wi-fi?";
          }
        },
      });
    },
    onMessage: (msg) => {
      if (SIGNAL_TYPES.has(msg.type)) {
        peer?.handleSignal(msg);
        return;
      }
      if (msg.type === "peer-status" && msg.status === "connected") {
        statusText.textContent = "celular conectado — abrindo canal direto…";
        eyebrowText.textContent = "conectado";
      }
      if (msg.type === "peer-status" && msg.status === "disconnected") {
        statusText.textContent = "celular desconectado";
        eyebrowText.textContent = "aguardando celular";
      }
      if (msg.type === "downloads-left") {
        statusText.textContent =
          msg.downloadsLeft > 0 ? `download confirmado — ${msg.downloadsLeft} restantes` : "download confirmado";
      }
      if (msg.type === "room-destroyed") {
        statusText.textContent = "sala encerrada";
        eyebrowText.textContent = "encerrada";
        dot.classList.add("off");
      }
    },
    onClose: () => {
      dot.classList.add("off");
    },
  });
}

createRoom();
