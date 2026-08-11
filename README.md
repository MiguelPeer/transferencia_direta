# poeira

Transferência de arquivo P2P efêmera entre celular e computador. Sem banco de dados, sem upload para servidor, sem cópia do arquivo em lugar nenhum além dos dois dispositivos envolvidos.

## Como funciona

1. O computador abre `/` → o servidor cria uma **sala** (token aleatório de 128 bits, TTL de 10min) e a página mostra um QR code apontando para `/r/<token>`.
2. O celular escaneia o QR → abre `/r/<token>` → os dois dispositivos entram na mesma sala pelo **servidor de sinalização** (WebSocket).
3. O servidor de sinalização troca só metadado de conexão (SDP/ICE) entre os dois peers — nunca vê o arquivo.
4. O arquivo viaja direto celular → computador via `RTCDataChannel` (WebRTC), com STUN e fallback TURN quando os dispositivos não estão na mesma rede.
5. Confirmado o download, o computador mostra "destruir agora" → dispara a animação de dissolução em partículas e descarta a sessão de verdade (a sala é destruída no servidor, não é só cosmético).

## Estado do projeto

Isto implementa as **etapas 1 a 4** do roadmap: servidor de sinalização + sala/token + QR code, conexão `RTCPeerConnection` real entre os dois peers, transferência do arquivo em si pelo `RTCDataChannel` (chunks de 16KB com backpressure, hash SHA-256 conferido nas duas pontas, sem recompressão — bytes e metadados como EXIF chegam intactos), e fallback TURN com credenciais efêmeras pra quando os dois peers não estão na mesma rede. O efeito de partículas aplicado ao arquivo real vem nas etapas seguintes — ver [prompt-projeto-poeira.md](prompt-projeto-poeira.md) para o roadmap completo e [preview.html](preview.html) para o protótipo de referência do efeito visual.

## Estrutura

```
server/           servidor de sinalização (Node.js, sem framework)
  src/
    index.js       HTTP + WS entrypoint, rotas de sala/QR/TURN
    rooms.js        RoomManager — estado em memória, TTL, destruição
    signaling.js     relay de SDP/ICE entre os dois peers de uma sala
    security.js      origin check, rate limiter, validação de mensagem
    turn.js          emissão de credenciais TURN efêmeras
web/              front-end estático (vanilla JS/HTML/CSS)
  index.html        página do computador (gera sala + QR)
  room.html         página do celular (entra na sala pelo token da URL)
  assets/
    styles.css        identidade visual (paleta, tipografia, componentes)
    signaling-client.js  cliente WS fino, só metadado de conexão
    webrtc-client.js     RTCPeerConnection + troca de SDP/ICE pelo canal de sinalização
    file-transfer.js     chunking + hash SHA-256 + reconstrução do arquivo pelo RTCDataChannel
    ice-config.js         busca credenciais TURN em /api/turn-credentials, monta STUN+TURN
    index-page.js         lógica da página do computador (script externo, exigido pela CSP)
    room-page.js          lógica da página do celular (idem)
preview.html      protótipo do efeito de dissolução em partículas (referência)
SECURITY.md       modelo de ameaças e decisões de segurança do projeto
```

## Rodando localmente

```bash
cd server
npm install
npm run dev
```

Abra `http://localhost:8787` no computador. Para testar com celular de verdade na mesma rede Wi-Fi, troque `localhost` pelo IP local da máquina (ex: `http://192.168.0.x:8787`) e ajuste `PUBLIC_BASE_URL` e `ALLOWED_ORIGINS` no `.env` (copie de `.env.example`) para esse endereço — senão o check de origem do WebSocket rejeita a conexão.

Para testar com os dois peers em **redes diferentes** (ex: celular em dados móveis), o STUN sozinho não basta — é preciso configurar `TURN_SECRET` e `TURN_URLS` no `.env` apontando pra um provedor TURN (ex: Metered, Twilio, ou um coturn próprio). Sem isso, `/api/turn-credentials` responde 204 e o client cai pra STUN-only, que só conecta quando há caminho direto entre os dois peers.

## Roadmap

1. ✅ Servidor de sinalização + sala/token + QR code
2. ✅ Conexão WebRTC entre os dois peers (mesma rede, via STUN, sem TURN)
3. ✅ Transferência via `RTCDataChannel` em chunks, com hash SHA-256 e metadados originais preservados
4. ✅ Fallback STUN/TURN para redes diferentes (credenciais efêmeras do `turn.js`, consumidas pelo client via `ice-config.js`)
5. Efeito de partículas aplicado ao arquivo real + descarte real da sessão ao destruir
6. Polimento visual final
