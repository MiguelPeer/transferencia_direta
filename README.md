# transferência direta

Transferência de arquivo P2P efêmera entre dois aparelhos quaisquer — celular↔celular, PC↔PC, celular↔PC ou PC↔celular. Sem banco de dados, sem upload para servidor, sem cópia do arquivo em lugar nenhum além dos dois dispositivos envolvidos.

## Como funciona

1. Quem abre a página escolhe um papel explícito: **enviar daqui** ou **receber aqui**. O servidor cria uma **sala** (token de 128 bits, TTL de 10min) com esse papel gravado.
2. A sala fica aberta mostrando **QR e código de 6 caracteres juntos** — são a mesma coisa em duas formas: quem tem câmera escaneia, quem não tem (ex: um PC sem webcam) digita o código no outro aparelho. Quem entra herda automaticamente o papel invertido, sem precisar escolher nada.
3. Os dois dispositivos entram na mesma sala pelo **servidor de sinalização** (WebSocket), que troca só metadado de conexão (SDP/ICE) — nunca vê o arquivo.
4. O arquivo viaja direto entre os dois via `RTCDataChannel` (WebRTC), com STUN e fallback TURN quando os dispositivos não estão na mesma rede.
5. Confirmado o recebimento, aparece "destruir agora" → dispara a animação de dissolução em partículas e descarta a sessão de verdade (a sala é destruída no servidor, não é só cosmético).

## Estado do projeto

Isto implementa o roadmap **completo (etapas 1 a 6)** do servidor de sinalização + transporte WebRTC — servidor de sinalização + sala/token, conexão `RTCPeerConnection` real, transferência do arquivo em si pelo `RTCDataChannel` (chunks de 16KB com backpressure, hash SHA-256 conferido nas duas pontas, sem recompressão — bytes e metadados como EXIF chegam intactos), fallback TURN com credenciais efêmeras, e o efeito de dissolução em partículas aplicado ao arquivo real recebido com descarte de verdade da sessão.

Por cima disso, a tela de conexão foi refeita pra não assumir mais "computador sempre mostra QR e recebe, celular sempre escaneia e envia" — qualquer aparelho pode abrir a sala como emissor ou receptor, e entrar nela por QR, código digitado ou QR lido pela própria câmera do navegador (sem depender do app de câmera do sistema). Isso destrava PC→PC (sem câmera nenhuma envolvida) e qualquer combinação de aparelhos, não só celular→PC.

Testado ponta a ponta na mesma rede; teste em redes diferentes com um provedor TURN real e deploy em produção ficam para depois — ver [prompt-projeto-poeira.md](prompt-projeto-poeira.md) para o roadmap original e [preview.html](preview.html)/[transferencia.html](transferencia.html) para os protótipos de referência do visual.

## Estrutura

```
server/           servidor de sinalização (Node.js, sem framework)
  src/
    index.js       HTTP + WS entrypoint, rotas de sala/QR/código/TURN
    rooms.js        RoomManager — estado em memória, TTL, código curto, destruição
    signaling.js     relay de SDP/ICE entre os dois peers de uma sala
    security.js      origin check, rate limiter, validação de mensagem
    turn.js          emissão de credenciais TURN efêmeras
web/              front-end estático (vanilla JS/HTML/CSS), pagina unica
  index.html        as 5 telas: intenção, sala aberta, código, scanner, transferência
  assets/
    styles.css        identidade visual (paleta, tipografia, componentes)
    signaling-client.js  cliente WS fino, só metadado de conexão
    webrtc-client.js     RTCPeerConnection + troca de SDP/ICE pelo canal de sinalização
    file-transfer.js     chunking + hash SHA-256 + reconstrução do arquivo pelo RTCDataChannel
    ice-config.js         busca credenciais TURN em /api/turn-credentials, monta STUN+TURN
    dissolve.js           efeito de dissolução em partículas aplicado ao preview real
    qr-scan.js             leitura de QR pela câmera do navegador (BarcodeDetector + fallback jsQR)
    app.js                 orquestra as 5 telas, papéis e a conexão de ponta a ponta
    vendor/jsqr.js          jsQR vendorizado localmente (sem CDN — CSP não permite)
preview.html      protótipo do efeito de dissolução em partículas (referência)
transferencia.html  protótipo da tela de conexão atual (referência)
SECURITY.md       modelo de ameaças e decisões de segurança do projeto
```

## Rodando localmente

```bash
cd server
npm install
npm run dev
```

Abra `http://localhost:8787`. Para testar com dois aparelhos de verdade na mesma rede Wi-Fi, troque `localhost` pelo IP local da máquina (ex: `http://192.168.0.x:8787`) e ajuste `PUBLIC_BASE_URL` e `ALLOWED_ORIGINS` no `.env` (copie de `.env.example`) para esse endereço — senão o check de origem do WebSocket rejeita a conexão. Repare que **a leitura de hash SHA-256 exige contexto seguro** (`https://` ou `localhost`) — acessar pelo IP da rede via `http://` funciona pra conectar, mas a verificação de integridade falha (com mensagem de erro clara, não trava silenciosamente).

Para testar com os dois peers em **redes diferentes** (ex: celular em dados móveis), o STUN sozinho não basta — é preciso configurar `TURN_SECRET` e `TURN_URLS` no `.env` apontando pra um provedor TURN (ex: Metered, Twilio, ou um coturn próprio). Sem isso, `/api/turn-credentials` responde 204 e o client cai pra STUN-only, que só conecta quando há caminho direto entre os dois peers.

## Roadmap

1. ✅ Servidor de sinalização + sala/token + QR code
2. ✅ Conexão WebRTC entre os dois peers (mesma rede, via STUN, sem TURN)
3. ✅ Transferência via `RTCDataChannel` em chunks, com hash SHA-256 e metadados originais preservados
4. ✅ Fallback STUN/TURN para redes diferentes (credenciais efêmeras do `turn.js`, consumidas pelo client via `ice-config.js`)
5. ✅ Efeito de partículas aplicado ao arquivo real recebido + descarte real da sessão ao destruir
6. ✅ Polimento visual final
7. ✅ Tela de conexão sem papel fixo por tipo de aparelho — enviar/receber explícito, entrada por QR, código digitado ou QR lido pela câmera do navegador
