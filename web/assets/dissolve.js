// Efeito de dissolucao em particulas aplicado ao arquivo real recebido - a
// assinatura visual do projeto (etapa 5). Amostra os pixels do preview
// (imagem ou frame atual do video) numa grade e anima cada amostra como uma
// particula que sobe e se desfaz, tipo poeira. Baseado no prototipo em
// preview.html, so que lendo a imagem de verdade em vez de um gradiente mock.

const STEP = 4; // resolucao da amostragem - menor = mais particulas, mais pesado
const FADE_RATE = 0.012;

function drawCover(ctx, source, sw, sh, dw, dh) {
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (dw - w) / 2, (dh - h) / 2, w, h);
}

function sourceSize(source) {
  if (source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight];
  return [source.naturalWidth, source.naturalHeight];
}

// Le o preview (img ou video) numa grade de particulas com a cor de cada
// amostra. width/height sao o tamanho de destino (a caixa .stage na tela).
export function buildParticles(source, width, height) {
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const octx = off.getContext("2d", { willReadFrequently: true });

  const [sw, sh] = sourceSize(source);
  if (sw > 0 && sh > 0) {
    drawCover(octx, source, sw, sh, width, height);
  } else {
    octx.fillStyle = "#5b7c99"; // sem frame decodificado - ainda da pra dissolver algo
    octx.fillRect(0, 0, width, height);
  }

  const imgData = octx.getImageData(0, 0, width, height);
  const particles = [];
  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      const i = (y * width + x) * 4;
      const a = imgData.data[i + 3];
      if (a < 40) continue;
      particles.push({
        x,
        y,
        r: imgData.data[i],
        g: imgData.data[i + 1],
        b: imgData.data[i + 2],
        size: STEP * 0.9,
        vx: (Math.random() - 0.5) * 0.3,
        vy: -0.4 - Math.random() * 0.6,
        life: 1,
        delay: (x / width) * 40 + Math.random() * 10,
      });
    }
  }
  return particles;
}

// Anima as particulas no canvas (ja dimensionado pro devicePixelRatio) ate
// todas sumirem, entao chama onDone.
export function runDissolve(canvas, particles, width, height, onDone) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let frame = 0;
  function tick() {
    ctx.clearRect(0, 0, width, height);
    frame++;
    let allDead = true;
    for (const p of particles) {
      if (frame < p.delay) {
        allDead = false;
        ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
        ctx.fillRect(p.x, p.y, p.size, p.size);
        continue;
      }
      p.life -= FADE_RATE;
      if (p.life <= 0) continue;
      allDead = false;
      p.x += p.vx + Math.sin((frame + p.y) * 0.02) * 0.3;
      p.y += p.vy;
      p.vy -= 0.006;
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      ctx.fillRect(p.x, p.y, p.size * p.life, p.size * p.life);
      ctx.globalAlpha = 1;
    }
    if (allDead) onDone?.();
    else requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
