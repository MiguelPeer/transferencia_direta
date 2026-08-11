// Guarda-corpos do servidor de sinalizacao: nada aqui decide o que fazer
// com o arquivo (isso e P2P), so protege o canal de metadado.

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:8787,http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function isOriginAllowed(origin) {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

// Rate limiter simples em memoria (janela deslizante por IP).
// Suficiente para um projeto de portfolio; em producao com varias
// instancias isso precisaria ser compartilhado (ex: Redis).
export class RateLimiter {
  #hits = new Map(); // ip -> timestamps[]

  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
  }

  check(ip) {
    const now = Date.now();
    const timestamps = (this.#hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    timestamps.push(now);
    this.#hits.set(ip, timestamps);
    return timestamps.length <= this.max;
  }

  // evita crescimento infinito do Map em processos de vida longa
  sweep() {
    const now = Date.now();
    for (const [ip, timestamps] of this.#hits) {
      const fresh = timestamps.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.#hits.delete(ip);
      else this.#hits.set(ip, fresh);
    }
  }
}

export function clientIp(req) {
  // Atras de proxy/load balancer configurar TRUST_PROXY=1 e usar x-forwarded-for.
  if (process.env.TRUST_PROXY === "1") {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

const SIGNALING_TYPES = new Set([
  "join",
  "offer",
  "answer",
  "ice-candidate",
  "peer-status",
  "download-confirmed",
  "destroy",
]);

// Mensagens de sinalizacao sao so metadado de conexao (SDP/ICE/controle).
// Nunca devem carregar bytes de arquivo - por isso o limite de tamanho
// e a validacao de "type" abaixo, alem do maxPayload no proprio ws server.
export function parseSignalingMessage(raw, { maxBytes = 32 * 1024 } = {}) {
  if (typeof raw !== "string" && !(raw instanceof Buffer)) return null;
  if (raw.length > maxBytes) return null;

  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || !SIGNALING_TYPES.has(msg.type)) return null;
  return msg;
}
