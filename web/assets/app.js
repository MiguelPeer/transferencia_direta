// Orquestra as 5 telas de "transferência direta". O transporte (WebRTC,
// hash, TURN, dissolução) não muda nada aqui - so reaproveita os modulos ja
// existentes. O que e novo: quem abre a sala escolhe o papel (enviar ou
// receber) explicitamente; quem entra depois (por QR, codigo digitado ou
// escaneado) herda o papel complementar automaticamente, resolvido pelo
// servidor via GET /api/rooms/:token ou /api/rooms/by-code/:code.

import { connectSignaling } from "/assets/signaling-client.js";
import { createPeerConnection } from "/assets/webrtc-client.js";
import { sendFile, createFileReceiver } from "/assets/file-transfer.js";
import { loadIceServers } from "/assets/ice-config.js";
import { buildParticles, runDissolve } from "/assets/dissolve.js";
import { hasCamera, extractToken, createScanner } from "/assets/qr-scan.js";

const $ = (id) => document.getElementById(id);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SIGNAL_TYPES = new Set(["offer", "answer", "ice-candidate"]);

let token = null;
let myRole = null; // "origin" (envia) | "dest" (recebe) - papel deste aparelho
let file = null; // arquivo escolhido, papel origin, antes de a sala existir
let ws = null;
let peer = null;
let timerId = null;
let scanner = null;
let pendingJoinIce = null; // setado quando quem ENTROU herdou papel "origin" e ainda precisa escolher o arquivo
let currentPreviewEl = null;
let currentBlobUrl = null;

const human = (b) => (b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : (b / 1048576).toFixed(1) + " MB");

/* ---------- diagrama (cabo animado) ---------- */
const cable = $("cable"), pulse = $("pulse"), diagram = $("diagram");
let sag = 42, target = 42, t = 0;
(function loop() {
  t += 0.02;
  sag += (target - sag) * 0.08;
  const s = sag + (reduce ? 0 : Math.sin(t) * (target > 4 ? 3 : 0));
  cable.setAttribute("d", `M 185 64 Q 300 ${64 + s} 415 64`);
  if (diagram.classList.contains("live")) {
    const p = (Date.now() % 1600) / 1600;
    const pt = cable.getPointAtLength(cable.getTotalLength() * p);
    pulse.setAttribute("cx", pt.x);
    pulse.setAttribute("cy", pt.y);
    pulse.style.opacity = Math.sin(p * Math.PI);
  } else {
    pulse.style.opacity = 0;
  }
  requestAnimationFrame(loop);
})();
const setLive = (on) => {
  diagram.classList.toggle("live", on);
  target = on ? 2 : 42;
};
const ports = (a, b) => {
  $("portA").textContent = a;
  $("portB").textContent = b;
};
const status = (txt, mode) => {
  $("statusText").textContent = txt;
  $("dot").className = "dot" + (mode ? " " + mode : "");
};
const toast = (m) => {
  const e = $("toast");
  e.textContent = m;
  e.classList.add("show");
  setTimeout(() => e.classList.remove("show"), 1800);
};

function show(id) {
  ["s1", "s2", "s3", "s4", "s5"].forEach((s) => $(s).classList.toggle("hide", s !== id));
  if (id !== "s4") scanner?.stop();
}
document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => location.reload()));

function startTimer() {
  const ends = Date.now() + 600000;
  clearInterval(timerId);
  timerId = setInterval(() => {
    const left = Math.max(0, ends - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $("timer").textContent = left ? `expira em ${m}:${String(s).padStart(2, "0")}` : "código expirado";
    if (!left) clearInterval(timerId);
  }, 1000);
}

/* ---------- abrir sala (quem escolhe enviar/receber) ---------- */
function openRoom(kind) {
  myRole = kind === "send" ? "origin" : "dest";
  show("s2");
  $("sendFile").classList.toggle("hide", kind !== "send");
  if (kind === "send") {
    $("roomBox").classList.add("hide");
    ports("este aparelho envia", "esperando alguém");
    status("escolha um arquivo para abrir a sala");
    $("timer").textContent = "—";
  } else {
    publish();
  }
}

async function publish() {
  status("criando sala…", "wait");
  try {
    const [res, iceServers] = await Promise.all([fetch(`/api/rooms?role=${myRole}`, { method: "POST" }), loadIceServers()]);
    if (!res.ok) throw new Error("falha ao criar sala");
    const room = await res.json();
    token = room.token;

    const qrRes = await fetch(room.qrUrl);
    $("qrBox").innerHTML = await qrRes.text();
    $("codeOut").textContent = room.code.split("").join(" ");
    $("roomBox").classList.remove("hide");
    $("roomEyebrow").textContent =
      myRole === "origin" ? "a sala está aberta · quem vai receber entra por aqui" : "a sala está aberta · quem tem o arquivo entra por aqui";
    startTimer();
    ports(myRole === "origin" ? "este aparelho envia" : "este aparelho recebe", "esperando alguém");
    status("sala aberta — esperando o outro lado", "wait");

    connectWs(iceServers, { isJoiner: false });
  } catch (err) {
    status("falha ao criar sala — recarregue a página");
    console.error("transferência direta: falha ao publicar sala", err);
  }
}

$("goSend").onclick = () => openRoom("send");
$("goRecv").onclick = () => openRoom("recv");

/* ---------- arquivo (papel origin) ---------- */
const drop = $("drop"), fileInput = $("fileInput");
drop.onclick = () => fileInput.click();
drop.onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
};
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  })
);
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && takeFile(e.dataTransfer.files[0]));
fileInput.onchange = (e) => e.target.files[0] && takeFile(e.target.files[0]);

function takeFile(f) {
  file = f;
  $("fileName").textContent = f.name;
  $("fileSize").textContent = human(f.size) + " · original preservado";
  drop.classList.add("hide");
  $("fileRow").classList.remove("hide");

  if (pendingJoinIce) {
    // quem ENTROU e herdou o papel "origin" so precisava do arquivo -
    // a sala ja existe, e so conectar.
    const iceServers = pendingJoinIce;
    pendingJoinIce = null;
    show("s5");
    setLive(true);
    startTimer();
    status("conectando…", "wait");
    connectWs(iceServers, { isJoiner: true });
  } else {
    publish();
  }
}
$("fileClear").onclick = () => {
  file = null;
  fileInput.value = "";
  $("fileRow").classList.add("hide");
  drop.classList.remove("hide");
  $("roomBox").classList.add("hide");
  clearInterval(timerId);
  $("timer").textContent = "—";
  status("escolha um arquivo para abrir a sala");
};
$("btnCopy").onclick = async () => {
  const room = $("codeOut").textContent.replace(/\s/g, "");
  if (!room) return;
  try {
    await navigator.clipboard.writeText(room);
    toast("código copiado");
  } catch {
    toast("copie manualmente: " + room);
  }
};

/* ---------- entrar com codigo ---------- */
const slots = Array.from($("slots").querySelectorAll("input"));
const typed = () => slots.map((i) => i.value).join("").toUpperCase();
const refreshSlots = () => {
  $("btnConnect").disabled = typed().length !== 6;
  $("slots").classList.remove("err");
};

slots.forEach((inp, i) => {
  inp.addEventListener("input", () => {
    inp.value = inp.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    if (inp.value && i < 5) slots[i + 1].focus();
    refreshSlots();
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !inp.value && i) slots[i - 1].focus();
    if (e.key === "ArrowLeft" && i) slots[i - 1].focus();
    if (e.key === "ArrowRight" && i < 5) slots[i + 1].focus();
    if (e.key === "Enter" && !$("btnConnect").disabled) joinByCode(typed());
  });
  inp.addEventListener("paste", (e) => {
    e.preventDefault();
    fillSlots(e.clipboardData.getData("text") || "");
  });
});
function fillSlots(raw) {
  const c = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 6).split("");
  slots.forEach((s, i) => (s.value = c[i] || ""));
  refreshSlots();
  slots[Math.min(c.length, 5)].focus();
}
$("goCode").onclick = () => {
  show("s3");
  slots[0].focus();
  status("digite o código");
};
$("btnPaste").onclick = async () => {
  try {
    fillSlots(await navigator.clipboard.readText());
  } catch {
    $("s3hint").textContent = "O navegador bloqueou a área de transferência. Digite o código.";
    slots[0].focus();
  }
};
$("btnConnect").onclick = () => joinByCode(typed());

/* ---------- scanner ---------- */
$("goScan").onclick = async () => {
  show("s4");
  status("procurando o QR", "wait");
  scanner = createScanner({
    video: $("scan"),
    onResult: (raw) => {
      scanner.stop();
      joinByToken(extractToken(raw));
    },
    onError: (reason) => {
      $("s4hint").innerHTML =
        reason === "camera_denied"
          ? "Este aparelho não liberou a câmera. <b>Use o código</b> em vez do QR."
          : "Este navegador não conseguiu ler o QR sozinho. <b>Use o código</b> em vez disso.";
      status("sem leitor de QR disponível");
    },
  });
  scanner.start();
};

/* ---------- entrar (por codigo, por QR escaneado, ou por link) ---------- */
async function joinByToken(tok) {
  status("procurando a sala…", "wait");
  try {
    const res = await fetch(`/api/rooms/${tok}`);
    if (!res.ok) throw new Error("sala nao encontrada");
    const info = await res.json();
    if (!info.joinRole) throw new Error("sala sem papel disponivel");
    await beginJoin(tok, info.joinRole);
  } catch (err) {
    status("sala não encontrada ou expirada — recarregue a página");
    console.error("transferência direta: falha ao entrar", err);
  }
}

async function joinByCode(code) {
  status("procurando a sala " + code + "…", "wait");
  try {
    const res = await fetch(`/api/rooms/by-code/${code}`);
    if (!res.ok) throw new Error("codigo invalido");
    const info = await res.json();
    await beginJoin(info.token, info.joinRole);
  } catch (err) {
    $("slots").classList.add("err");
    $("s3hint").textContent = "Código inválido ou expirado. Confira e tente de novo.";
    $("s3hint").classList.add("error");
    console.error("transferência direta: codigo invalido", err);
  }
}

async function beginJoin(tok, role) {
  token = tok;
  myRole = role;
  const iceServers = await loadIceServers();

  if (myRole === "origin") {
    // herdei o papel de quem envia - preciso de um arquivo antes de conectar
    show("s2");
    $("sendFile").classList.remove("hide");
    $("roomBox").classList.add("hide");
    ports("este aparelho envia", "conectado");
    status("escolha um arquivo para enviar");
    pendingJoinIce = iceServers;
    return;
  }

  show("s5");
  setLive(true);
  startTimer();
  ports("este aparelho recebe", "conectado");
  status("linha aberta — conectando…", "wait");
  connectWs(iceServers, { isJoiner: true });
}

/* ---------- sinalizacao + webrtc (comum a quem abre e a quem entra) ---------- */
function connectWs(iceServers, { isJoiner }) {
  ws = connectSignaling({
    token,
    role: myRole,
    onOpen: () => {
      peer = createPeerConnection({
        isInitiator: myRole === "origin",
        iceServers,
        sendSignal: (msg) => ws.send(JSON.stringify(msg)),
        onDataChannel: setupDataChannel,
        onStateChange: handleConnState,
      });
      // quem ENTRA depois de a sala ja existir pode ofertar na hora (o outro
      // lado ja esta conectado, por definicao). Quem ABRIU a sala precisa
      // esperar o "peer-status connected" avisando que alguem chegou -
      // ofertar antes disso se perderia (sem fila de sinalizacao no servidor).
      if (myRole === "origin" && isJoiner) peer.startOffer();
    },
    onMessage: (msg) => {
      if (SIGNAL_TYPES.has(msg.type)) {
        peer?.handleSignal(msg);
        return;
      }
      if (msg.type === "peer-status" && msg.status === "connected") {
        ports($("portA").textContent, "conectado");
        status("outro aparelho conectado — abrindo canal direto…", "wait");
        if (myRole === "origin" && !isJoiner) peer.startOffer();
      }
      if (msg.type === "peer-status" && msg.status === "disconnected") {
        status("outro aparelho desconectado");
        ports($("portA").textContent, "desconectado");
      }
      if (msg.type === "downloads-left") {
        status(msg.downloadsLeft > 0 ? `download confirmado — ${msg.downloadsLeft} restantes` : "download confirmado", "on");
      }
      if (msg.type === "room-destroyed") {
        setLive(false);
        ports("linha encerrada", "desconectado");
        status("sala encerrada");
        clearInterval(timerId);
        $("timer").textContent = "—";
      }
    },
    onClose: () => {},
  });
}

function handleConnState(state) {
  if (state === "connecting") status("estabelecendo canal direto…", "wait");
  if (state === "failed" || state === "disconnected") status("falha no canal direto — mesma rede?");
}

/* ---------- transferencia do arquivo ---------- */
function setupDataChannel(channel) {
  if (myRole === "origin") {
    channel.addEventListener("open", async () => {
      show("s5");
      setLive(true);
      $("moveName").textContent = file.name;
      $("moveSize").textContent = human(file.size) + " · original preservado";
      status("enviando arquivo…", "wait");
      try {
        await sendFile(channel, file, { onProgress: updateProgress });
        status("arquivo enviado — aguardando confirmação", "on");
        $("moveHint").textContent = "Assim que o outro lado destruir, some dos dois aparelhos.";
      } catch (err) {
        status(err.message || "falha ao enviar arquivo");
        console.error("transferência direta: falha no envio", err);
      }
    });
  } else {
    const handleMessage = createFileReceiver({
      onMeta: (meta) => {
        show("s5");
        setLive(true);
        $("moveName").textContent = meta.name;
        $("moveSize").textContent = human(meta.size) + " · original preservado";
        updateProgress(0, meta.size);
        status("recebendo arquivo…", "wait");
      },
      onProgress: updateProgress,
      onComplete: onFileReceived,
      onError: (reason) => {
        status(reason === "integrity_mismatch" ? "falha de integridade — arquivo corrompido" : "falha ao receber arquivo");
        $("moveHint").textContent = reason === "integrity_mismatch" ? "o hash recebido não confere — peça pra enviar de novo" : reason;
      },
    });
    channel.addEventListener("message", (ev) => handleMessage(ev.data));
  }
}

function updateProgress(sent, total) {
  const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
  $("barFill").style.width = pct + "%";
  $("movePct").textContent = pct + "%";
}

function onFileReceived({ blob, name, mime }) {
  const url = URL.createObjectURL(blob);
  const isVideo = mime.startsWith("video/");
  const previewEl = isVideo ? $("previewVideo") : $("previewImg");
  previewEl.src = url;
  previewEl.classList.remove("hide");
  (isVideo ? $("previewImg") : $("previewVideo")).classList.add("hide");

  currentPreviewEl = previewEl;
  currentBlobUrl = url;

  $("movePct").textContent = "pronto";
  $("moveHint").textContent = "Chegou inteiro. Destrua quando não precisar mais — some dos dois lados.";
  status("arquivo recebido", "on");
  $("doneRow").classList.remove("hide");

  // download acontece na hora - o arquivo ja esta integro e verificado
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  ws.send(JSON.stringify({ type: "download-confirmed" }));
}

/* ---------- destruir ---------- */
$("btnDestroy").onclick = () => {
  const btn = $("btnDestroy");
  btn.disabled = true;
  const stage = $("stage"), dust = $("dust"), moveRow = $("moveRow");
  const w = stage.clientWidth, h = stage.clientHeight;
  const particles = buildParticles(currentPreviewEl, w, h);

  currentPreviewEl.classList.add("hide");
  moveRow.classList.add("fade-out");
  dust.classList.remove("hide");

  runDissolve(dust, particles, w, h, () => {
    ws.send(JSON.stringify({ type: "destroy" }));
    URL.revokeObjectURL(currentBlobUrl);
    currentPreviewEl.removeAttribute("src");
    dust.getContext("2d").clearRect(0, 0, dust.width, dust.height);
    moveRow.classList.add("hide");
    $("barFill").style.width = "0%";
    $("moveHint").textContent = "Destruído. Não existe cópia em lugar nenhum.";
    setLive(false);
    ports("linha encerrada", "desconectado");
    status("sala encerrada");
    clearInterval(timerId);
    $("timer").textContent = "—";
  });
};
$("btnAgain").onclick = () => location.reload();

/* ---------- entrada ---------- */
const deepLinkToken = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)/);
if (deepLinkToken) {
  joinByToken(deepLinkToken[1]);
} else {
  hasCamera().then((ok) => {
    if (!ok) {
      $("goScan").classList.add("hide");
      $("s1hint").textContent = "Não achamos câmera aqui — a entrada por código funciona igual.";
    }
  });
  status("escolha um lado para começar");
}
