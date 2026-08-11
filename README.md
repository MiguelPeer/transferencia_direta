# poeira

Transferência de arquivo P2P efêmera entre celular e computador. Sem banco de dados, sem upload para servidor, sem cópia do arquivo em lugar nenhum além dos dois dispositivos envolvidos.

## Como funciona

1. O computador abre `/` → o servidor cria uma **sala** (token aleatório de 128 bits, TTL de 10min) e a página mostra um QR code apontando para `/r/<token>`.
2. O celular escaneia o QR → abre `/r/<token>` → os dois dispositivos entram na mesma sala pelo **servidor de sinalização** (WebSocket).
3. O servidor de sinalização troca só metadado de conexão (SDP/ICE) entre os dois peers — nunca vê o arquivo.
4. O arquivo viaja direto celular → computador via `RTCDataChannel` (WebRTC), com STUN e fallback TURN quando os dispositivos não estão na mesma rede.
5. Confirmado o download, o computador mostra "destruir agora" → dispara a animação de dissolução em partículas e descarta a sessão de verdade (a sala é destruída no servidor, não é só cosmético).

## Estado do projeto

Isto implementa a **etapa 1** do roadmap: servidor de sinalização + sala/token + QR code, com as duas páginas (computador e celular) já trocando status de conexão em tempo real. WebRTC, transferência de arquivo e o efeito de partículas aplicado ao arquivo real vêm nas etapas seguintes — ver [prompt-projeto-poeira.md](prompt-projeto-poeira.md) para o roadmap completo e [preview.html](preview.html) para o protótipo de referência do efeito visual.

## Estrutura

```
server/           servidor de sinalização (Node.js, sem framework)
  src/
    index.js       HTTP + WS entrypoint, rotas de sala/QR/TURN
    rooms.js        RoomManager — estado em memória, TTL, destruição
    signaling.js     relay de SDP/ICE entre os dois peers de uma sala
    security.js      origin check, rate limiter, validação de mensagem
    turn.js          emissão de credenciais TURN efêmeras (etapa 4)
web/              front-end estático (vanilla JS/HTML/CSS)
  index.html        página do computador (gera sala + QR)
  room.html         página do celular (entra na sala pelo token da URL)
  assets/
    styles.css        identidade visual (paleta, tipografia, componentes)
    signaling-client.js  cliente WS fino, só metadado de conexão
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

## Roadmap

1. ✅ Servidor de sinalização + sala/token + QR code
2. Conexão WebRTC entre os dois peers (mesma rede primeiro, sem TURN)
3. Transferência via `RTCDataChannel` em chunks, com hash de integridade e metadados originais preservados
4. Fallback STUN/TURN para redes diferentes (`turn.js` já emite credenciais efêmeras, falta o client usá-las)
5. Efeito de partículas aplicado ao arquivo real + descarte real da sessão ao destruir
6. Polimento visual final
