import crypto from "node:crypto";

// Credenciais TURN efemeras (esquema REST padrao usado por coturn, Metered, etc).
// Username = "<expiracao_unix>:poeira", Password = HMAC-SHA1(username, TURN_SECRET) em base64.
// Isso evita secret estatico exposto no cliente e limita o uso do relay a uma janela curta.
// So ativa quando TURN_SECRET/TURN_URLS estiverem configurados (etapa 4 do roadmap).

const TURN_CRED_TTL_S = 5 * 60; // 5 minutos de validade por credencial

export function issueTurnCredentials() {
  const secret = process.env.TURN_SECRET;
  const urls = process.env.TURN_URLS;
  if (!secret || !urls) return null;

  const expiresAt = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_S;
  const username = `${expiresAt}:poeira`;
  const password = crypto.createHmac("sha1", secret).update(username).digest("base64");

  return {
    username,
    credential: password,
    ttl: TURN_CRED_TTL_S,
    urls: urls.split(",").map((u) => u.trim()),
  };
}
