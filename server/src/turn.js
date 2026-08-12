import crypto from "node:crypto";

// Tres formas de emitir credenciais TURN, da mais segura pra mais simples -
// a primeira que estiver configurada vence:
//
// 1. Dinamica via API do provedor (Metered) - TURN_METERED_DOMAIN/
//    TURN_METERED_SECRET_KEY. O servidor chama a API deles com a secret key
//    (que nunca sai daqui) e repassa ao cliente uma credencial que expira
//    sozinha depois de METERED_CRED_TTL_S segundos.
//
// 2. Efemera via secret compartilhado (esquema REST padrao do coturn, e de
//    alguns provedores) - TURN_SECRET/TURN_URLS. Username = "<expiracao_unix>:poeira",
//    Password = HMAC-SHA1(username, TURN_SECRET) em base64. O secret nunca
//    sai do servidor, e cada credencial vale por poucos minutos.
//
// 3. Credencial fixa emitida no painel do provedor - TURN_STATIC_USERNAME/
//    TURN_STATIC_CREDENTIAL/TURN_URLS. Nao expira sozinha (o provedor
//    controla isso do lado dele) - pra revogar, remove a credencial no
//    painel deles. Usado so quando nenhuma das opcoes acima esta disponivel.

const TURN_CRED_TTL_S = 5 * 60; // esquema efemero HMAC
const METERED_CRED_TTL_S = 40 * 60; // credencial dinamica: cobre o teto de 30min de sala conectada com folga

async function issueMeteredCredential(urlList) {
  const domain = process.env.TURN_METERED_DOMAIN;
  const secretKey = process.env.TURN_METERED_SECRET_KEY;
  if (!domain || !secretKey) return null;

  try {
    const res = await fetch(`https://${domain}/api/v1/turn/credential?secretKey=${encodeURIComponent(secretKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiryInSeconds: METERED_CRED_TTL_S, label: "transferencia-direta" }),
    });
    if (!res.ok) return null;
    const { username, password } = await res.json();
    if (!username || !password) return null;
    return { username, credential: password, ttl: METERED_CRED_TTL_S, urls: urlList };
  } catch {
    return null; // provedor fora do ar - cai pros proximos esquemas configurados
  }
}

export async function issueTurnCredentials() {
  const urls = process.env.TURN_URLS;
  if (!urls) return null;
  const urlList = urls.split(",").map((u) => u.trim());

  const metered = await issueMeteredCredential(urlList);
  if (metered) return metered;

  const staticUsername = process.env.TURN_STATIC_USERNAME;
  const staticCredential = process.env.TURN_STATIC_CREDENTIAL;
  if (staticUsername && staticCredential) {
    return { username: staticUsername, credential: staticCredential, ttl: null, urls: urlList };
  }

  const secret = process.env.TURN_SECRET;
  if (!secret) return null;

  const expiresAt = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_S;
  const username = `${expiresAt}:poeira`;
  const password = crypto.createHmac("sha1", secret).update(username).digest("base64");

  return {
    username,
    credential: password,
    ttl: TURN_CRED_TTL_S,
    urls: urlList,
  };
}
