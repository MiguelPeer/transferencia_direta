import { connectSignaling } from "/assets/signaling-client.js";
import { createPeerConnection } from "/assets/webrtc-client.js";
import { createFileReceiver } from "/assets/file-transfer.js";
import { loadIceServers } from "/assets/ice-config.js";
import { buildParticles, runDissolve } from "/assets/dissolve.js";
import { switchPanel } from "/assets/panels.js";

const dot = document.getElementById("dot");
const eyebrowText = document.getElementById("eyebrowText");
const heading = document.getElementById("heading");
const subtext = document.getElementById("subtext");
const qrBox = document.getElementById("qrBox");
const qrLabel = document.getElementById("qrLabel");
const tokenLabel = document.getElementById("tokenLabel");
const statusText = document.getElementById("statusText");
const stage = document.getElementById("stage");
const qrWrap = document.getElementById("qrWrap");
const transfer = document.getElementById("transfer");
const transferName = document.getElementById("transferName");
const progressFill = document.getElementById("progressFill");
const transferPct = document.getElementById("transferPct");
const received = document.getElementById("received");
const previewImg = document.getElementById("previewImg");
const previewVideo = document.getElementById("previewVideo");
const dissolveCanvas = document.getElementById("dissolveCanvas");
const receivedName = document.getElementById("receivedName");
const receivedHint = document.getElementById("receivedHint");
const downloadBtn = document.getElementById("downloadBtn");
const destroyBtn = document.getElementById("destroyBtn");

const SIGNAL_TYPES = new Set(["offer", "answer", "ice-candidate"]);

const stagePanels = [qrWrap, transfer, received];
function showPanel(el) {
  switchPanel(stagePanels, el);
}

function setProgress(receivedBytes, total) {
  const pct = total > 0 ? Math.round((receivedBytes / total) * 100) : 0;
  progressFill.style.width = `${pct}%`;
  transferPct.textContent = `${pct}%`;
}

async function createRoom() {
  let res, iceServers, room, svg;
  try {
    [res, iceServers] = await Promise.all([fetch("/api/rooms", { method: "POST" }), loadIceServers()]);
    if (!res.ok) {
      statusText.textContent = "falha ao criar sala — recarregue a página";
      dot.classList.add("off");
      return;
    }
    room = await res.json();
    const qrRes = await fetch(room.qrUrl);
    svg = await qrRes.text();
  } catch (err) {
    statusText.textContent = "falha ao criar sala — recarregue a página";
    dot.classList.add("off");
    console.error("poeira: falha ao criar sala", err);
    return;
  }

  tokenLabel.textContent = room.token.slice(0, 8);
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
            onComplete: ({ blob, name, mime }) => {
              statusText.textContent = "arquivo recebido";
              heading.textContent = `${name} recebido`;
              subtext.textContent = "Transferido direto do celular. Qualidade e metadados originais preservados.";
              receivedName.textContent = name;
              receivedHint.textContent = "integridade confirmada — hash sha-256 conferido";

              const url = URL.createObjectURL(blob);
              const isVideo = mime.startsWith("video/");
              const previewEl = isVideo ? previewVideo : previewImg;
              previewEl.src = url;
              previewEl.hidden = false;
              (isVideo ? previewImg : previewVideo).hidden = true;

              showPanel(received);

              downloadBtn.onclick = () => {
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                a.click();
                ws.send(JSON.stringify({ type: "download-confirmed" }));
                downloadBtn.disabled = true;
                downloadBtn.textContent = "baixado";
                destroyBtn.hidden = false;
              };

              destroyBtn.onclick = () => {
                destroyBtn.disabled = true;
                const rect = stage.getBoundingClientRect();
                const w = Math.floor(rect.width);
                const h = Math.floor(rect.height);
                const particles = buildParticles(previewEl, w, h);

                previewEl.hidden = true;
                dissolveCanvas.hidden = false;
                runDissolve(dissolveCanvas, particles, w, h, () => {
                  ws.send(JSON.stringify({ type: "destroy" }));
                  URL.revokeObjectURL(url);
                  previewEl.removeAttribute("src");
                  dissolveCanvas.getContext("2d").clearRect(0, 0, dissolveCanvas.width, dissolveCanvas.height);
                  statusText.textContent = "arquivo descartado";
                  receivedName.textContent = "descartado";
                  receivedHint.textContent = "a sessão foi destruída — nada ficou salvo em servidor";
                  downloadBtn.hidden = true;
                  destroyBtn.textContent = "gerar novo código";
                  destroyBtn.disabled = false;
                  destroyBtn.onclick = () => location.reload();
                });
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

createRoom().catch((err) => {
  statusText.textContent = "algo deu errado — recarregue a página";
  dot.classList.add("off");
  console.error("poeira: erro inesperado", err);
});
