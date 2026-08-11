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
- **Headers de segurança** em toda resposta HTTP: `Content-Security-Policy` restritiva (sem scripts inline, sem fontes externas além do Google Fonts), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- **Estado 100% em memória** — reiniciar o processo apaga todas as salas. Não há dump em disco, log de arquivo transferido, nem analytics de conteúdo.

Em produção, o servidor precisa rodar atrás de TLS (`wss://`) — o código já resolve `ws`/`wss` dinamicamente pelo protocolo da página, mas o TLS em si é responsabilidade do proxy/host escolhido (fora do escopo deste servidor Node puro).

## Camada WebRTC (etapas 2–4, ainda não implementada)

- `RTCDataChannel` usa **DTLS obrigatório** — o navegador não permite desligar a criptografia do canal, então o arquivo trafega cifrado ponta a ponta mesmo quando passa pelo relay TURN.
- **STUN** só revela o IP público de cada peer ao outro peer — isso é inerente a qualquer WebRTC e já é visível em qualquer chamada de vídeo (Meet, WhatsApp); não é um vazamento introduzido por este projeto, mas vale deixar explícito.
- **TURN com credenciais efêmeras** (`server/src/turn.js`): username/password válidos por 5min, gerados via HMAC a partir de um secret que nunca sai do servidor — evita secret estático exposto no cliente e limita quanto tempo uma credencial vazada continua útil.
- Ao escolher o provedor TURN na etapa 4, documentar aqui a política de retenção dele — o relay não deveria logar payload, mas isso depende do provedor escolhido, não só do código deste projeto.

## Integridade e metadados do arquivo (etapa 3, ainda não implementada)

- Hash (SHA-256) calculado no dispositivo de origem e conferido no destino, pra garantir que o arquivo chegou bit-a-bit igual — sem isso não dá pra prometer "qualidade 100% original".
- Como o arquivo nunca passa por processamento server-side, EXIF e metadados chegam intactos por padrão (o risco de perda existe só se o próprio client recodificar o arquivo antes de enviar — a implementação da etapa 3 deve evitar isso).

## Fora do escopo (de propósito)

- **Autenticação de usuário.** O sistema é intencionalmente anônimo e sem conta — a "identidade" de quem pode participar é só quem tem o link/QR da sala.
- **Vazamento do QR/link antes do scan pretendido.** Se alguém mais escanear o QR antes do destinatário certo, essa pessoa ocupa a vaga de `origin`. Mitigado por TTL curto e pela sala aceitar só o primeiro peer por papel, mas não há verificação de identidade — é uma troca deliberada por simplicidade, coerente com o resto do produto (portfólio, não um cofre de dados sensíveis).
- **Dispositivo comprometido em qualquer ponta.** Malware/extensão maliciosa no navegador de origem ou destino está fora do que esta arquitetura pode proteger.

## Dependências

O servidor tem só duas dependências diretas (`ws`, `qrcode`) — de propósito, pra manter a superfície de ataque pequena e o código auditável de ponta a ponta.
