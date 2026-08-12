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

const MAX_FILES = 5;

let token = null;
let myRole = null; // "origin" (envia) | "dest" (recebe) - papel deste aparelho
let files = []; // arquivos escolhidos, papel origin, antes de a sala existir (max MAX_FILES)
let ws = null;
let peer = null;
let timerId = null;
let scanner = null;
let pendingJoinIce = null; // setado quando quem ENTROU herdou papel "origin" e ainda precisa escolher os arquivos
let receivedFiles = []; // papel dest: {blob, name, url, thumbEl, dustEl} de cada arquivo recebido, na ordem
let expectedTotal = 1; // quantos arquivos o lote atual deve ter, avisado no meta do primeiro

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

/* ---------- arquivos (papel origin) - ate MAX_FILES por vez ---------- */
const drop = $("drop"), fileInput = $("fileInput"), fileList = $("fileList");
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
drop.addEventListener("drop", (e) => e.dataTransfer.files.length && takeFiles(e.dataTransfer.files));
fileInput.onchange = (e) => e.target.files.length && takeFiles(e.target.files);

function renderFileList() {
  fileList.innerHTML = "";
  files.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `
      <span class="file-glyph"><i></i></span>
      <span class="file-meta"><strong></strong><span></span></span>
      <button class="file-x" type="button">remover</button>
    `;
    row.querySelector(".file-meta strong").textContent = f.name;
    row.querySelector(".file-meta span").textContent = human(f.size) + " · original preservado";
    row.querySelector(".file-x").onclick = () => removeFile(i);
    fileList.appendChild(row);
  });
}

function removeFile(idx) {
  files.splice(idx, 1);
  if (files.length === 0) {
    fileList.classList.add("hide");
    drop.classList.remove("hide");
    $("roomBox").classList.add("hide");
    clearInterval(timerId);
    $("timer").textContent = "—";
    status("escolha um arquivo para abrir a sala");
    return;
  }
  renderFileList();
}

function takeFiles(selected) {
  const picked = Array.from(selected).slice(0, MAX_FILES);
  files = picked;
  renderFileList();
  drop.classList.add("hide");
  fileList.classList.remove("hide");

  if (selected.length > MAX_FILES) {
    toast(`só os primeiros ${MAX_FILES} arquivos foram usados`);
  }

  if (pendingJoinIce) {
    // quem ENTROU e herdou o papel "origin" so precisava dos arquivos -
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
      status("enviando arquivo…", "wait");
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          $("moveName").textContent = f.name;
          $("moveSize").textContent = human(f.size) + (files.length > 1 ? ` · arquivo ${i + 1} de ${files.length}` : " · original preservado");
          $("movePct").textContent = "0%";
          $("barFill").style.width = "0%";
          status(files.length > 1 ? `enviando arquivo ${i + 1}/${files.length}…` : "enviando arquivo…", "wait");
          await sendFile(channel, f, { onProgress: updateProgress, index: i + 1, total: files.length });
        }
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
        $("stage").classList.remove("hide");
        expectedTotal = meta.total ?? 1;
        const idx = meta.index ?? receivedFiles.length + 1;
        $("moveName").textContent = meta.name;
        $("moveSize").textContent = human(meta.size) + (expectedTotal > 1 ? ` · arquivo ${idx} de ${expectedTotal}` : " · original preservado");
        updateProgress(0, meta.size);
        status(expectedTotal > 1 ? `recebendo arquivo ${idx}/${expectedTotal}…` : "recebendo arquivo…", "wait");
      },
      onProgress: updateProgress,
      onComplete: addReceivedFile,
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

function addReceivedFile({ blob, name, mime }) {
  const url = URL.createObjectURL(blob);
  const isVideo = mime.startsWith("video/");
  const isImage = mime.startsWith("image/");

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  let mediaEl;
  if (isImage || isVideo) {
    mediaEl = document.createElement(isVideo ? "video" : "img");
    mediaEl.className = "thumb-media";
    mediaEl.src = url;
    if (isVideo) {
      mediaEl.muted = true;
      mediaEl.playsInline = true;
    }
  } else {
    // sem preview de pixel real (nao e imagem/video) - cartao generico com a
    // extensao. dissolve.js ja cai pro preenchimento solido de cor quando o
    // elemento nao tem naturalWidth/videoWidth, entao a dissolucao ainda roda.
    mediaEl = document.createElement("div");
    mediaEl.className = "thumb-media thumb-file";
    const icon = document.createElement("i");
    const label = document.createElement("span");
    const ext = name.includes(".") ? name.split(".").pop() : "arquivo";
    label.textContent = ext.slice(0, 4).toUpperCase();
    mediaEl.append(icon, label);
  }
  const dustEl = document.createElement("canvas");
  dustEl.className = "thumb-dust hide";
  const nameEl = document.createElement("span");
  nameEl.className = "thumb-name";
  nameEl.textContent = name;
  thumb.append(mediaEl, dustEl, nameEl);
  $("thumbGrid").appendChild(thumb);
  $("thumbGrid").classList.remove("hide");

  receivedFiles.push({ blob, name, mime, url, thumb, mediaEl, dustEl });

  if (receivedFiles.length < expectedTotal) {
    status(`arquivo recebido — ${receivedFiles.length}/${expectedTotal}`, "wait");
    return;
  }

  $("stage").classList.add("hide");
  status("arquivo recebido", "on");
  $("moveHint").textContent =
    receivedFiles.length > 1
      ? "Chegaram inteiros, íntegros. Clica em \"Guardar\" pra salvar no aparelho."
      : "Chegou inteiro, íntegro. Clica em \"Guardar\" pra salvar no aparelho.";
  $("doneRow").classList.remove("hide");
  $("btnSave").disabled = false;
  $("btnSave").textContent = "Guardar";
  $("btnDestroy").hidden = true;
}

/* ---------- guardar (baixa de verdade, so entao libera destruir) ---------- */
$("btnSave").onclick = () => {
  const btn = $("btnSave");
  btn.disabled = true;
  btn.textContent = "Guardado";

  receivedFiles.forEach(({ url, name }) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
  });
  ws.send(JSON.stringify({ type: "download-confirmed" }));

  $("btnDestroy").hidden = false;
  $("moveHint").textContent =
    receivedFiles.length > 1 ? "Guardados. Destrua quando não precisar mais — some dos dois lados." : "Guardado. Destrua quando não precisar mais — some dos dois lados.";
};

/* ---------- destruir (dissolve paralelo de cada miniatura) ---------- */
$("btnDestroy").onclick = () => {
  const btn = $("btnDestroy");
  btn.disabled = true;

  const dissolves = receivedFiles.map(({ mediaEl, dustEl, thumb }) => {
    const w = thumb.clientWidth, h = thumb.clientHeight;
    const particles = buildParticles(mediaEl, w, h);
    mediaEl.classList.add("hide");
    dustEl.classList.remove("hide");
    return new Promise((resolve) => runDissolve(dustEl, particles, w, h, resolve));
  });

  Promise.all(dissolves).then(() => {
    ws.send(JSON.stringify({ type: "destroy" }));
    receivedFiles.forEach(({ url }) => URL.revokeObjectURL(url));
    receivedFiles = [];
    $("thumbGrid").innerHTML = "";
    $("thumbGrid").classList.add("hide");
    $("doneRow").classList.add("hide");
    $("moveHint").textContent = "Destruído. Não existe cópia em lugar nenhum.";
    setLive(false);
    ports("linha encerrada", "desconectado");
    status("sala encerrada");
    clearInterval(timerId);
    $("timer").textContent = "—";
  });
};

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
