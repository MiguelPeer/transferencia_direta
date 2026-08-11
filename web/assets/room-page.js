import { connectSignaling } from "/assets/signaling-client.js";
import { createPeerConnection } from "/assets/webrtc-client.js";
import { sendFile } from "/assets/file-transfer.js";
import { loadIceServers } from "/assets/ice-config.js";
import { switchPanel } from "/assets/panels.js";

const dot = document.getElementById("dot");
const eyebrowText = document.getElementById("eyebrowText");
const centerMsg = document.getElementById("centerMsg");
const statusText = document.getElementById("statusText");
const filePicker = document.getElementById("filePicker");
const fileInput = document.getElementById("fileInput");
const pickFileBtn = document.getElementById("pickFileBtn");
const transfer = document.getElementById("transfer");
const transferName = document.getElementById("transferName");
const progressFill = document.getElementById("progressFill");
const transferPct = document.getElementById("transferPct");

const SIGNAL_TYPES = new Set(["offer", "answer", "ice-candidate"]);
const token = location.pathname.replace(/^\/r\//, "");

const stagePanels = [centerMsg, filePicker, transfer];
function showPanel(el) {
  switchPanel(stagePanels, el);
}

function setProgress(sent, total) {
  const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  transferPct.textContent = `${pct}%`;
}

pickFileBtn.addEventListener("click", () => fileInput.click());

if (!token) {
  statusText.textContent = "link inválido";
  dot.classList.add("off");
} else {
  let dataChannel = null;
  let peer = null;
  const iceServers = await loadIceServers();

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file || !dataChannel) return;

    transferName.textContent = file.name;
    setProgress(0, file.size);
    showPanel(transfer);
    statusText.textContent = "enviando arquivo…";

    try {
      await sendFile(dataChannel, file, {
        onProgress: (sent, total) => setProgress(sent, total),
      });
      statusText.textContent = "arquivo enviado — aguardando confirmação";
    } catch (err) {
      statusText.textContent = err.message || "falha ao enviar arquivo";
      console.error("poeira: falha no envio", err);
    }
  });

  const ws = connectSignaling({
    token,
    role: "origin",
    onOpen: () => {
      statusText.textContent = "conectado à sala — abrindo canal direto";
      peer = createPeerConnection({
        isInitiator: true,
        iceServers,
        sendSignal: (msg) => ws.send(JSON.stringify(msg)),
        onDataChannel: (channel) => {
          dataChannel = channel;
          channel.addEventListener("open", () => {
            statusText.textContent = "canal direto pronto";
            showPanel(filePicker);
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
      peer.startOffer();
    },
    onMessage: (msg) => {
      if (SIGNAL_TYPES.has(msg.type)) {
        peer?.handleSignal(msg);
        return;
      }
      if (msg.type === "joined") {
        eyebrowText.textContent = "sala " + msg.token.slice(0, 8);
      }
      if (msg.type === "peer-status" && msg.status === "connected") {
        centerMsg.textContent = "computador conectado — abrindo canal direto…";
      }
      if (msg.type === "peer-status" && msg.status === "disconnected") {
        statusText.textContent = "computador desconectado";
        showPanel(centerMsg);
        centerMsg.textContent = "aguardando computador…";
      }
      if (msg.type === "downloads-left") {
        statusText.textContent =
          msg.downloadsLeft > 0 ? `download confirmado — ${msg.downloadsLeft} restantes` : "download confirmado";
      }
      if (msg.type === "room-destroyed") {
        statusText.textContent = "sala encerrada";
        showPanel(centerMsg);
        centerMsg.textContent = "esta sala não existe mais";
        dot.classList.add("off");
      }
    },
    onClose: () => {
      dot.classList.add("off");
      if (statusText.textContent !== "sala encerrada") {
        statusText.textContent = "conexão perdida";
      }
    },
  });
}
