import crypto from "node:crypto";

// Duas formas de emitir credenciais TURN, dependendo do que o provedor
// oferece:
//
// 1. Efemera via secret compartilhado (esquema REST padrao do coturn, e de
//    alguns provedores) - TURN_SECRET/TURN_URLS. Username = "<expiracao_unix>:poeira",
//    Password = HMAC-SHA1(username, TURN_SECRET) em base64. O secret nunca
//    sai do servidor, e cada credencial vale por poucos minutos.
//
// 2. Credencial fixa emitida no painel do provedor (ex: Metered.ca, que
//    gera usuario/senha prontos em vez de expor um secret pra HMAC) -
//    TURN_STATIC_USERNAME/TURN_STATIC_CREDENTIAL/TURN_URLS. Nao expira
//    sozinha (o provedor controla isso do lado dele) - pra revogar, remove
//    a credencial no painel deles.
//
// So ativa quando um dos dois pares de variavel estiver configurado.

const TURN_CRED_TTL_S = 5 * 60; // 5 minutos de validade por credencial (esquema efemero)

export function issueTurnCredentials() {
  const urls = process.env.TURN_URLS;
  if (!urls) return null;
  const urlList = urls.split(",").map((u) => u.trim());

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
