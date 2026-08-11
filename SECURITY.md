# Segurança — projeto poeira

O projeto existe pra resolver um problema de privacidade (arquivo pessoal passando por servidor de terceiro, ficando salvo em algum lugar). Isso só vale a pena se a arquitetura realmente sustentar essa promessa. Este documento registra o modelo de ameaças e as decisões tomadas — e o que fica de fora de propósito.

## O que o sistema protege

- **O arquivo nunca é persistido em disco/banco em nenhum ponto do caminho.** Nem no servidor de sinalização (que só vê SDP/ICE), nem no relay TURN quando ele entra em cena (relay repassa bytes opacos, não decodifica nem grava).
- **A sala é efêmera e de uso único.** Token de 128 bits (imprevisível), TTL de 10min sem os dois peers conectados, teto de 30min depois de conectados, e destruição imediata quando: os downloads acabam, alguém clica "destruir agora", ou um dos dois peers cai.
- **Só os dois dispositivos combinados pela sala participam.** Cada sala aceita exatamente um `origin` (quem envia) e um `dest` (quem recebe); uma terceira tentativa de entrar é rejeitada.

## Servidor de sinalização

O servidor de sinalização é o único componente que roda em infraestrutura minha — por isso é o que recebe mais atenção:

- **Allowlist de origem** no upgrade do WebSocket (`ALLOWED_ORIGINS`): conexão de qualquer origem fora da lista é recusada com 403 antes mesmo do handshake.
- **Validação estrita de mensagem**: só os tipos conhecidos (`join`, `offer`, `answer`, `ice-candidate`, `download-confirmed`, `destroy`, ...) são aceitos; qualquer coisa fora do schema fecha a conexão.
- **Limite de tamanho de mensagem** (32KB, via `maxPayload` do `ws` + checagem manual) — sinalização não precisa de mais que isso, então não há como usar esse canal pra empurrar dados grandes.
- **Rate limiting por IP**: criação de sala (10/min) e conexões WebSocket (30/min) — mitiga abuso/DoS trivial sem precisar de infraestrutura extra.
- **Heartbeat (ping/pong a cada 30s)** derruba conexões mortas, evitando que salas fiquem presas na memória por peers que sumiram sem fechar a conexão corretamente.
- **Headers de segurança** em toda resposta HTTP: `Content-Security-Policy` restritiva (sem scripts inline — por isso toda lógica de página vive em arquivos `.js` externos em `web/assets/`, nunca em `<script>` inline —, sem fontes externas além do Google Fonts), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. `connect-src` inclui `stun:`, `turn:` e `turns:` porque alguns navegadores aplicam a CSP também às URLs de ICE server do `RTCPeerConnection`.
- **Estado 100% em memória** — reiniciar o processo apaga todas as salas. Não há dump em disco, log de arquivo transferido, nem analytics de conteúdo.

Em produção, o servidor precisa rodar atrás de TLS (`wss://`) — o código já resolve `ws`/`wss` dinamicamente pelo protocolo da página, mas o TLS em si é responsabilidade do proxy/host escolhido (fora do escopo deste servidor Node puro).

## Camada WebRTC (etapas 2–4 implementadas)

- A conexão `RTCPeerConnection` em si (etapa 2) já está no ar: `origin` (celular) sempre inicia a oferta e cria o `RTCDataChannel`; `dest` (computador) fica passivo esperando. Isso funciona porque `dest` sempre conecta ao WebSocket de sinalização antes do QR aparecer na tela — não há fila de sinalização no servidor, então uma oferta enviada antes do outro peer estar conectado se perderia.
- `RTCDataChannel` usa **DTLS obrigatório** — o navegador não permite desligar a criptografia do canal, então o arquivo trafega cifrado ponta a ponta mesmo quando passa pelo relay TURN.
- **STUN** só revela o IP público de cada peer ao outro peer — isso é inerente a qualquer WebRTC e já é visível em qualquer chamada de vídeo (Meet, WhatsApp); não é um vazamento introduzido por este projeto, mas vale deixar explícito.
- **TURN com credenciais efêmeras** (`server/src/turn.js`, etapa 4): username/password válidos por 5min, gerados via HMAC-SHA1 a partir de um secret que nunca sai do servidor (esquema REST/static-auth-secret, o mesmo que coturn e a maioria dos provedores usam) — evita secret estático exposto no cliente e limita quanto tempo uma credencial vazada continua útil. O client (`web/assets/ice-config.js`) busca essas credenciais em `GET /api/turn-credentials` antes de abrir a conexão e as inclui na lista de `iceServers` ao lado do STUN público; sem `TURN_SECRET`/`TURN_URLS` configurados no servidor, o endpoint responde 204 e o client cai pra STUN-only (só conecta com caminho direto entre os peers).
- O navegador tenta candidatos diretos (host/srflx) primeiro por prioridade ICE e só usa o relay TURN quando não há caminho direto — o TURN aqui é fallback, não substitui a tentativa de conexão P2P direta.
- Validado localmente com um TURN server efêmero (`node-turn`) reproduzindo a validação HMAC do esquema REST: com `iceTransportPolicy: "relay"` forçado nos dois peers, o `RTCDataChannel` abriu e trocou dados só através do relay, confirmando que as credenciais emitidas por `turn.js` são aceitas por um TURN server real, não só que o código compila.
- Ao escolher o provedor TURN em produção, documentar aqui a política de retenção dele — o relay não deveria logar payload, mas isso depende do provedor escolhido, não só do código deste projeto.

## Integridade e metadados do arquivo (etapa 3, implementada)

- O arquivo é lido inteiro em memória no dispositivo de origem (`file.arrayBuffer()`) e transferido em chunks binários crus de 16KB pelo `RTCDataChannel` — sem passar por `<canvas>` nem qualquer recodificação, então bytes e metadados (EXIF etc.) chegam intactos por padrão, exatamente como no arquivo original.
- **Hash SHA-256** calculado via Web Crypto (`crypto.subtle.digest`) no dispositivo de origem antes do envio e recalculado no destino depois de reconstruído o `Blob` — se não bater, o destino recusa o arquivo e mostra "falha de integridade" em vez de oferecer o download.
- Como o Web Crypto do navegador não tem hash incremental, o cálculo exige o buffer completo em memória — suficiente para foto/vídeo de uso típico; um arquivo de vários GB exigiria hash incremental à parte (fora do escopo atual).
- **Backpressure no envio**: o remetente monitora `dataChannel.bufferedAmount` e pausa novos chunks acima de 1MB em buffer local, retomando só quando esvaziar abaixo de 256KB — evita estourar memória do navegador em arquivos grandes ou redes lentas.
- O download só é liberado no destino depois que o hash confere; o clique em "baixar arquivo" dispara o `download-confirmed` de sinalização já existente desde a etapa 1, decrementando o contador de downloads da sala.

## Fora do escopo (de propósito)

- **Autenticação de usuário.** O sistema é intencionalmente anônimo e sem conta — a "identidade" de quem pode participar é só quem tem o link/QR da sala.
- **Vazamento do QR/link antes do scan pretendido.** Se alguém mais escanear o QR antes do destinatário certo, essa pessoa ocupa a vaga de `origin`. Mitigado por TTL curto e pela sala aceitar só o primeiro peer por papel, mas não há verificação de identidade — é uma troca deliberada por simplicidade, coerente com o resto do produto (portfólio, não um cofre de dados sensíveis).
- **Dispositivo comprometido em qualquer ponta.** Malware/extensão maliciosa no navegador de origem ou destino está fora do que esta arquitetura pode proteger.

## Dependências

O servidor tem só duas dependências diretas (`ws`, `qrcode`) — de propósito, pra manter a superfície de ataque pequena e o código auditável de ponta a ponta.
