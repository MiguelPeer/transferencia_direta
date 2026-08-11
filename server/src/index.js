import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { RoomManager } from "./rooms.js";
import { isOriginAllowed, RateLimiter, clientIp } from "./security.js";
import { handleConnection } from "./signaling.js";
import { issueTurnCredentials } from "./turn.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "../../web");

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

const roomManager = new RoomManager();
const createRoomLimiter = new RateLimiter({ windowMs: 60_000, max: 10 }); // 10 salas/min/IP
const wsConnectLimiter = new RateLimiter({ windowMs: 60_000, max: 30 }); // 30 conexoes ws/min/IP

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      "connect-src 'self' ws: wss: stun: turn: turns:; base-uri 'none'; form-action 'none'; object-src 'none'"
  );
}

// Serve os arquivos estaticos do front (dev only - em producao,
// use um host estatico/CDN na frente e mantenha isto so como servidor de sinalizacao).
async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(WEB_DIR, rel));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type =
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[ext] ??
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const url = new URL(req.url, PUBLIC_BASE_URL);
  const ip = clientIp(req);

  if (req.method === "POST" && url.pathname === "/api/rooms") {
    if (!createRoomLimiter.check(ip)) return json(res, 429, { error: "rate_limited" });
    const room = roomManager.create();
    const joinUrl = `${PUBLIC_BASE_URL}/r/${room.token}`;
    return json(res, 201, {
      token: room.token,
      joinUrl,
      qrUrl: `/api/rooms/${room.token}/qr`,
      maxDownloads: room.maxDownloads,
    });
  }

  const qrMatch = url.pathname.match(/^\/api\/rooms\/([\w-]+)\/qr$/);
  if (req.method === "GET" && qrMatch) {
    const token = qrMatch[1];
    const room = roomManager.get(token);
    if (!room) return json(res, 404, { error: "room_not_found" });
    const joinUrl = `${PUBLIC_BASE_URL}/r/${token}`;
    const svg = await QRCode.toString(joinUrl, { type: "svg", margin: 1, color: { dark: "#1c1b1a", light: "#edeae4" } });
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
    return res.end(svg);
  }

  const statusMatch = url.pathname.match(/^\/api\/rooms\/([\w-]+)$/);
  if (req.method === "GET" && statusMatch) {
    const room = roomManager.get(statusMatch[1]);
    if (!room) return json(res, 404, { error: "room_not_found" });
    return json(res, 200, { status: room.status, downloadsLeft: room.downloadsLeft });
  }

  if (req.method === "GET" && url.pathname === "/api/turn-credentials") {
    const creds = issueTurnCredentials();
    if (!creds) {
      // 204 nao pode ter corpo (RFC 7231) - funciona por acidente em conexao
      // direta, mas trava atras de proxies mais rigorosos (ex: tuneis).
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }
    return json(res, 200, creds);
  }

  // rota amigavel /r/<token> tambem serve a mesma pagina de sala (roteamento no client)
  if (req.method === "GET" && url.pathname.startsWith("/r/")) {
    return serveStatic(req, res, "/room.html");
  }

  if (req.method === "GET") {
    return serveStatic(req, res, url.pathname);
  }

  res.writeHead(405).end();
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024, // sinalizacao nunca precisa de mais que isso
});

server.on("upgrade", (req, socket, head) => {
  const ip = clientIp(req);
  const origin = req.headers.origin;

  if (!isOriginAllowed(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!wsConnectLimiter.check(ip)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = new URL(req.url, PUBLIC_BASE_URL);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token");
  const role = url.searchParams.get("role");
  const room = token ? roomManager.get(token) : null;

  if (!room || room.status === "destroyed" || !["origin", "dest"].includes(role) || roomManager.isRoleTaken(token, role)) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    roomManager.attach(token, role, ws);
    log(`peer ${role} entrou na sala ${token}`);
    handleConnection(ws, { token, role, roomManager, log });
  });
});

// heartbeat: derruba conexoes mortas para nao segurar salas travadas na memoria
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

const sweepInterval = setInterval(() => {
  createRoomLimiter.sweep();
  wsConnectLimiter.sweep();
}, 60_000);

server.listen(PORT, () => {
  log(`servidor de sinalizacao poeira ouvindo em ${PUBLIC_BASE_URL}`);
});

process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  clearInterval(sweepInterval);
  server.close(() => process.exit(0));
});
