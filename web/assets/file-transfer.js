// Transferencia do arquivo pelo RTCDataChannel ja aberto (etapa 2). Chunks
// binarios crus - sem passar por canvas nem recodificar - preservam os
// bytes e metadados (EXIF etc) originais. SHA-256 calculado nas duas pontas
// pra garantir que o arquivo chegou bit-a-bit igual.
//
// O arquivo inteiro e lido em memoria (file.arrayBuffer()) pra poder hashear
// com Web Crypto, que so hasheia buffers completos (sem API de hash
// incremental no navegador). Suficiente pros tamanhos de foto/video de uso
// tipico; um arquivo de varios GB exigiria um hash incremental à parte.

const CHUNK_SIZE = 16 * 1024; // 16KB - tamanho conservador, compativel com toda a base de navegadores
const BUFFERED_AMOUNT_HIGH = 1 * 1024 * 1024; // pausa o envio acima de 1MB de buffer local
const BUFFERED_AMOUNT_LOW = 256 * 1024; // retoma quando o buffer esvaziar abaixo disso

async function sha256Hex(buffer) {
  // crypto.subtle so existe em contexto seguro (https ou localhost) - acessar
  // pelo IP da rede local via http:// (comum ao testar com celular de verdade)
  // cai aqui. Falha explicita em vez de travar silenciosamente em 0%.
  if (!crypto.subtle) {
    throw new Error("hash sha-256 indisponível neste dispositivo (exige https ou localhost)");
  }
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sendFile(channel, file, { onProgress, index, total } = {}) {
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);

  channel.send(
    JSON.stringify({
      type: "file-meta",
      name: file.name,
      size: buffer.byteLength,
      mime: file.type || "application/octet-stream",
      sha256,
      // index/total sao opcionais - so usados quando um lote de varios
      // arquivos e enviado em sequencia, pro receptor saber quantos faltam
      index,
      total,
    })
  );

  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;

  let offset = 0;
  while (offset < buffer.byteLength) {
    if (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
      await new Promise((resolve) => channel.addEventListener("bufferedamountlow", resolve, { once: true }));
    }
    const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
    channel.send(buffer.slice(offset, end));
    offset = end;
    onProgress?.(offset, buffer.byteLength);
  }

  channel.send(JSON.stringify({ type: "file-end" }));
}

// Consome mensagens cruas do RTCDataChannel (o channel precisa estar com
// binaryType "arraybuffer", ja garantido pelo webrtc-client.js) e reconstroi
// o arquivo. Retorna a funcao que deve ser plugada no listener "message".
export function createFileReceiver({ onMeta, onProgress, onComplete, onError }) {
  let meta = null;
  let chunks = [];
  let received = 0;

  async function finish() {
    if (!meta) return;
    try {
      const blob = new Blob(chunks, { type: meta.mime });
      const buffer = await blob.arrayBuffer();
      const sha256 = await sha256Hex(buffer);
      if (sha256 !== meta.sha256) {
        onError?.("integrity_mismatch");
        return;
      }
      onComplete?.({ blob, name: meta.name, mime: meta.mime, size: meta.size, index: meta.index, total: meta.total });
    } catch (err) {
      onError?.(err.message ?? "erro desconhecido ao reconstruir arquivo");
    }
  }

  return function handleMessage(data) {
    if (typeof data === "string") {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === "file-meta") {
        meta = msg;
        chunks = [];
        received = 0;
        onMeta?.(meta);
      } else if (msg.type === "file-end") {
        finish();
      }
      return;
    }

    chunks.push(data);
    received += data.byteLength;
    onProgress?.(received, meta?.size ?? received);
  };
}
