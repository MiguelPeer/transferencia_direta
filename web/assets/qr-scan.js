// Leitura de QR pela camera do proprio navegador (nao depende do app de
// camera do sistema). Usa BarcodeDetector nativo quando disponivel (Chrome/
// Edge/Android) e cai pro jsQR vendorizado (window.jsQR, carregado via
// <script> classico em index.html) quando nao - o Safari/iOS, por exemplo,
// nao implementa BarcodeDetector, e "botao que nao funciona e pior que
// botao ausente" e requisito do produto.

export async function hasCamera() {
  if (!navigator.mediaDevices?.enumerateDevices) return false;
  try {
    return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === "videoinput");
  } catch {
    return false;
  }
}

// Extrai o token de sala de um valor de QR decodificado (URL completa tipo
// .../r/<token>) - aceita tambem o token cru, caso o QR contenha so isso.
export function extractToken(rawValue) {
  const m = rawValue.match(/\/r\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : rawValue.trim();
}

export function createScanner({ video, onResult, onError }) {
  let stream = null;
  let raf = null;
  let stopped = false;

  async function start() {
    stopped = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch {
      onError?.("camera_denied");
      return;
    }
    video.srcObject = stream;
    await video.play();

    if ("BarcodeDetector" in window) {
      scanWithBarcodeDetector();
    } else if (window.jsQR) {
      scanWithJsQR();
    } else {
      onError?.("no_decoder");
    }
  }

  function scanWithBarcodeDetector() {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const tick = async () => {
      if (stopped) return;
      try {
        const [hit] = await detector.detect(video);
        if (hit) {
          onResult(hit.rawValue);
          return;
        }
      } catch {
        // frame ilegivel (ex: video ainda sem dados) - so tenta de novo
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function scanWithJsQR() {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (stopped) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = window.jsQR(imgData.data, imgData.width, imgData.height);
        if (hit) {
          onResult(hit.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stop() {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  return { start, stop };
}
