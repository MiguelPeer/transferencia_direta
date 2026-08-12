# Segurança: transferência direta

O projeto existe pra resolver um problema de privacidade (arquivo pessoal passando por servidor de terceiro, ficando salvo em algum lugar). Isso só vale a pena se a arquitetura realmente sustentar essa promessa. Este documento registra o modelo de ameaças, as decisões tomadas e o que fica de fora de propósito.

## O que o sistema protege

- **O arquivo nunca é persistido em disco/banco em nenhum ponto do caminho.** Nem no servidor de sinalização (que só vê SDP/ICE), nem no relay TURN quando ele entra em cena (relay repassa bytes opacos, não decodifica nem grava).
- **A sala é efêmera e de uso único.** Token de 128 bits (imprevisível), TTL de 10min sem os dois peers conectados, teto de 30min depois de conectados, e destruição imediata quando: os downloads acabam, alguém clica "destruir agora", ou um dos dois peers cai.
- **Só os dois dispositivos combinados pela sala participam.** Cada sala aceita exatamente um `origin` (quem envia) e um `dest` (quem recebe), papel escolhido explicitamente por quem abre a sala, não amarrado a "computador" ou "celular"; uma terceira tentativa de entrar é rejeitada.

## Servidor de sinalização

O servidor de sinalização é o único componente que roda em infraestrutura minha, por isso é o que recebe mais atenção:

- **Allowlist de origem** no upgrade do WebSocket (`ALLOWED_ORIGINS`): conexão de qualquer origem fora da lista é recusada com 403 antes mesmo do handshake. Suporta um curinga de subdomínio (ex: `https://*.loca.lt`) só pra facilitar teste atrás de túneis/preview hosts efêmeros em dev; nunca usar curinga em produção, onde a lista deve ser de origens exatas.
- **Validação estrita de mensagem**: só os tipos conhecidos (`join`, `offer`, `answer`, `ice-candidate`, `download-confirmed`, `destroy`, ...) são aceitos; qualquer coisa fora do schema fecha a conexão.
- **Limite de tamanho de mensagem** (32KB, via `maxPayload` do `ws` + checagem manual): sinalização não precisa de mais que isso, então não há como usar esse canal pra empurrar dados grandes.
- **Rate limiting por IP**: criação de sala (10/min) e conexões WebSocket (30/min); mitiga abuso/DoS trivial sem precisar de infraestrutura extra.
- **Heartbeat (ping/pong a cada 30s)** derruba conexões mortas, evitando que salas fiquem presas na memória por peers que sumiram sem fechar a conexão corretamente.
- **Headers de segurança** em toda resposta HTTP: `Content-Security-Policy` restritiva (sem scripts inline: por isso toda lógica de página vive em arquivos `.js` externos em `web/assets/`, nunca em `<script>` inline; sem fontes externas além do Google Fonts), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. `connect-src` inclui `stun:`, `turn:` e `turns:` porque alguns navegadores aplicam a CSP também às URLs de ICE server do `RTCPeerConnection`; `img-src`/`media-src` incluem `blob:` pro preview do arquivo recebido, que é sempre um `Blob` local, nunca uma URL remota.
- **Estado 100% em memória**: reiniciar o processo apaga todas as salas. Não há dump em disco, log de arquivo transferido, nem analytics de conteúdo.

Em produção, o servidor precisa rodar atrás de TLS (`wss://`); o código já resolve `ws`/`wss` dinamicamente pelo protocolo da página, mas o TLS em si é responsabilidade do proxy/host escolhido (fora do escopo deste servidor Node puro).

## Camada WebRTC

- A conexão `RTCPeerConnection` em si: `origin` (quem envia) sempre inicia a oferta e cria o `RTCDataChannel`; `dest` (quem recebe) fica passivo esperando. Como qualquer aparelho pode abrir a sala com qualquer papel, quem oferta nem sempre é o segundo a conectar: `origin` só chama `startOffer()` na hora certa, imediatamente se ele é quem está *entrando* na sala (o outro lado, por definição, já está lá), ou só depois de receber `peer-status: connected` se ele é quem *abriu* a sala (aí espera o outro lado avisar que chegou). Isso evita o mesmo problema de antes (sem fila de sinalização no servidor, uma oferta enviada antes do outro peer conectar se perderia), só que agora sem assumir qual papel conecta primeiro.
- `RTCDataChannel` usa **DTLS obrigatório**: o navegador não permite desligar a criptografia do canal, então o arquivo trafega cifrado ponta a ponta mesmo quando passa pelo relay TURN.
- **STUN** só revela o IP público de cada peer ao outro peer; isso é inerente a qualquer WebRTC e já é visível em qualquer chamada de vídeo (Meet, WhatsApp), não é um vazamento introduzido por este projeto, mas vale deixar explícito.
- **TURN com credenciais efêmeras** (`server/src/turn.js`): username/password válidos por 5min, gerados via HMAC-SHA1 a partir de um secret que nunca sai do servidor (esquema REST/static-auth-secret, o mesmo que coturn usa); evita secret estático exposto no cliente e limita quanto tempo uma credencial vazada continua útil. Nem todo provedor expõe esse secret pra HMAC, porém: o Metered.ca, por exemplo, gera credenciais fixas (usuário/senha) prontas no painel deles; `turn.js` aceita as duas formas (`TURN_SECRET` pro esquema efêmero, ou `TURN_STATIC_USERNAME`/`TURN_STATIC_CREDENTIAL` pra credencial fixa); nesse segundo caso a credencial não expira sozinha, quem controla isso é o provedor (revogar = remover no painel deles). O client (`web/assets/ice-config.js`) busca essas credenciais em `GET /api/turn-credentials` antes de abrir a conexão e as inclui na lista de `iceServers` ao lado do STUN público; sem nada configurado no servidor, o endpoint responde 204 e o client cai pra STUN-only (só conecta com caminho direto entre os peers).
- O navegador tenta candidatos diretos (host/srflx) primeiro por prioridade ICE e só usa o relay TURN quando não há caminho direto; o TURN aqui é fallback, não substitui a tentativa de conexão P2P direta.
- Validado localmente com um TURN server efêmero (`node-turn`) reproduzindo a validação HMAC do esquema REST: com `iceTransportPolicy: "relay"` forçado nos dois peers, o `RTCDataChannel` abriu e trocou dados só através do relay, confirmando que as credenciais emitidas por `turn.js` são aceitas por um TURN server real, não só que o código compila.
- Ao escolher o provedor TURN em produção, documentar aqui a política de retenção dele: o relay não deveria logar payload, mas isso depende do provedor escolhido, não só do código deste projeto.

## Código de sala digitável

Pra funcionar sem câmera (ex: PC→PC), a sala pode ser encontrada por um código de 6 caracteres em vez de escanear o QR. Decisão deliberada: o **código não é o identificador da sala**, é uma chave de busca separada e mais fraca que o servidor resolve pro mesmo token forte de 128 bits (`RoomManager.getByCode`, `GET /api/rooms/by-code/:code`). O QR continua carregando o token forte direto, sem regressão pra quem escaneia.

- Alfabeto de 33 caracteres (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, sem `0/O/1/I`, pensado pra ser ditado por telefone) dá 33⁶ ≈ 1,3 bilhão de combinações por código.
- Rate limiter dedicado no endpoint de busca por código (20 tentativas/min/IP), separado do limiter de criação de sala; mais apertado porque esse endpoint tem bem menos entropia pra proteger.
- Combinado com o TTL de 10min da sala, isso torna força-bruta impraticável: mesmo sem throttling nenhum, testar 1,3 bilhão de combinações em 10 minutos exigiria ~2,2 milhões de tentativas por segundo; com o rate limit, um único IP não chega nem perto disso.
- O código nunca precisa de HTTPS/contexto seguro pra funcionar (ao contrário do hash SHA-256): é só uma string comparada no servidor.

## Leitura de QR pela câmera do navegador

Além de abrir o QR com o app de câmera do sistema, dá pra ler o QR direto de dentro da página (`web/assets/qr-scan.js`); útil quando os dois aparelhos já estão com a página aberta. Usa `BarcodeDetector` nativo quando disponível e cai pro **jsQR** (biblioteca pura em JS, vendorizada localmente em `web/assets/vendor/jsqr.js`, sem CDN) quando não: o Safari/iOS, por exemplo, não implementa `BarcodeDetector`. Tudo roda local no navegador: os frames da câmera nunca saem do dispositivo, não há upload de imagem pra lugar nenhum.

## Integridade e metadados do arquivo

- O arquivo é lido inteiro em memória no dispositivo de origem (`file.arrayBuffer()`) e transferido em chunks binários crus de 16KB pelo `RTCDataChannel`; sem passar por `<canvas>` nem qualquer recodificação, então bytes e metadados (EXIF etc.) chegam intactos por padrão, exatamente como no arquivo original.
- **Hash SHA-256** calculado via Web Crypto (`crypto.subtle.digest`) no dispositivo de origem antes do envio e recalculado no destino depois de reconstruído o `Blob`; se não bater, o destino recusa o arquivo e mostra "falha de integridade" em vez de oferecer o download.
- Como o Web Crypto do navegador não tem hash incremental, o cálculo exige o buffer completo em memória; suficiente para foto/vídeo de uso típico, um arquivo de vários GB exigiria hash incremental à parte (fora do escopo atual).
- **Backpressure no envio**: o remetente monitora `dataChannel.bufferedAmount` e pausa novos chunks acima de 1MB em buffer local, retomando só quando esvaziar abaixo de 256KB; evita estourar memória do navegador em arquivos grandes ou redes lentas.
- O download só é liberado no destino depois que o hash confere; o clique em "baixar arquivo" dispara o `download-confirmed` de sinalização, decrementando o contador de downloads da sala.

## Dissolução e descarte real

- O botão "destruir agora" só aparece depois que o download é confirmado (`web/assets/app.js`). Ao clicar: a animação de partículas (`dissolve.js`) amostra os pixels do preview real (imagem ou frame atual do vídeo) direto de um `<canvas>` local; nada disso sai do navegador, é só leitura de pixel local pra decidir a cor de cada partícula.
- O descarte não é só a animação: ao terminar, o client manda `destroy` pela sinalização, o servidor destrói a sala de verdade (`RoomManager.destroy`) e fecha os dois WebSockets. Do lado do client, o `Blob` do arquivo é liberado (`URL.revokeObjectURL`) e as referências ao `src` da mídia são removidas, então nada fica retido em memória depois.
- Se o usuário nunca clicar em "destruir agora", a sala ainda expira pelos mecanismos já existentes (TTL de 10min sem conexão, teto de 30min conectados, ou limite de downloads): o botão é conveniência, não a única rede de segurança.

## Fora do escopo (de propósito)

- **Autenticação de usuário.** O sistema é intencionalmente anônimo e sem conta; a "identidade" de quem pode participar é só quem tem o link/QR da sala.
- **Vazamento do QR/link antes do scan pretendido.** Se alguém mais escanear o QR antes do destinatário certo, essa pessoa ocupa a vaga de `origin`. Mitigado por TTL curto e pela sala aceitar só o primeiro peer por papel, mas não há verificação de identidade; é uma troca deliberada por simplicidade, coerente com o resto do produto (portfólio, não um cofre de dados sensíveis).
- **Dispositivo comprometido em qualquer ponta.** Malware/extensão maliciosa no navegador de origem ou destino está fora do que esta arquitetura pode proteger.

## Dependências

O servidor tem só duas dependências diretas (`ws`, `qrcode`), de propósito, pra manter a superfície de ataque pequena e o código auditável de ponta a ponta. No client, a única dependência de terceiro é o **jsQR** (leitura de QR pela câmera), vendorizado localmente como arquivo estático em vez de vir de CDN; a CSP do projeto não permite `script-src` externo, e vendorizar evita depender da disponibilidade/integridade de um host de terceiro em runtime.
