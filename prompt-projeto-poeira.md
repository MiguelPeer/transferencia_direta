# Prompt para Claude Code — Projeto "Poeira" (transferência P2P efêmera)

Copie e cole o bloco abaixo no Claude Code para iniciar o projeto. Ajuste o que fizer sentido conforme for avançando.

---

## Contexto do projeto

Quero construir um projeto de portfólio chamado **"poeira"** (nome provisório): um site que permite transferir arquivos (imagens e vídeos, depois posso expandir para outros tipos) entre um celular e um computador **sem passar por banco de dados nem guardar dados do usuário**, e com um efeito visual de "autodestruição em partículas" ao final.

## Fluxo funcional

1. O usuário abre o site no **computador** → a página gera um **QR code** único (token de sessão)
2. O usuário escaneia o QR com o **celular** → abre a mesma "sala" no navegador do celular (sem precisar instalar app)
3. O celular faz upload de um arquivo (imagem ou vídeo) → o arquivo é transferido **diretamente para o computador via WebRTC** (peer-to-peer), sem passar pelo meu servidor e sem ser salvo em nenhum banco de dados
4. Se os dois dispositivos **não estiverem na mesma rede** (ex: computador em rede corporativa, celular em dados móveis), a conexão deve funcionar mesmo assim, usando STUN e, como fallback, um servidor TURN (relay) — nesse caso os bytes passam pelo relay, mas **nunca são persistidos em disco/banco**, só repassados
5. O arquivo chega ao computador em **qualidade e metadados 100% originais** — sem recompressão, sem perda de EXIF (diferencial em relação ao WhatsApp Web, que degrada qualidade)
6. Depois que o download é confirmado no computador, aparece um botão **"destruir agora"**
7. Ao clicar, dispara uma **animação de dissolução em partículas** (efeito tipo "Thanos") sobre a prévia do arquivo, e, junto com a animação, o dado é de fato descartado (não é só cosmético) — a sessão/sala expira e não pode mais ser usada

## Requisitos técnicos

- **Sem banco de dados relacional para arquivos ou dados pessoais.** O único estado que precisa persistir, e por pouco tempo, é o **código da sala** (ativo/inativo, TTL curto) — pode ser em memória (ex: um Map no servidor de sinalização) ou Redis, não precisa de Postgres/Oracle para isso.
- **Servidor de sinalização** (WebSocket) para troca de SDP/ICE entre os dois peers — transporta só metadado da conexão, nunca o arquivo em si.
- **WebRTC `RTCDataChannel`** para o transporte do arquivo em chunks binários, peer-to-peer.
- **STUN** para descoberta de IP público (ex: STUN público do Google) e **TURN** como fallback quando P2P direto não é possível (ex: usar um provedor com free tier, como Metered ou similar — a decidir).
- **QR code** gerado no front-end a partir do token de sessão (lib tipo `qrcode` no client ou geração server-side).
- Stack sugerida (ajustável): front-end simples (pode ser vanilla JS/HTML/CSS ou um framework leve), back-end Node.js para o servidor de sinalização WebSocket.

## Direção visual (já definida — seguir à risca)

Fugir dos clichês visuais de "design feito por IA" (fundo bege + serifada + laranja terracota; fundo preto + neon; estilo jornal com hairlines). A estética deve remeter a **algo efêmero que se desfaz em pó/fumaça**.

- **Paleta**: cinza-grafite escuro de fumaça como fundo (`#1C1B1A`, com um tom ligeiramente mais claro `#232220` para cards), branco-osso para texto (`#EDEAE4`), texto secundário em cinza-claro (`#A8A49C`), linhas/bordas sutis (`#35332F`), e um único accent azul-poeira frio (`#5B7C99`, com variante mais escura `#3D5266`) — nada de laranja nem verde-ácido.
- **Tipografia**: `JetBrains Mono` para status técnico, labels e dados (reforça "sistema real, não decoração"); `Inter` para títulos e texto corrido. Evitar a combinação clichê serifada+sans.
- **Tom da copy**: direto e técnico, na voz do sistema — "Aguardando conexão", "3 downloads restantes", "Arquivo descartado" — nunca em tom de venda ("Envie seus arquivos com segurança!").
- **Assinatura visual única da página**: o efeito de dissolução em partículas no momento de destruir o arquivo. É o único momento "uau" da interface — o resto (tela de QR, status de conexão, metadados do arquivo) deve ficar quieto e funcional, sem competir com esse momento.
- Já existe um protótipo funcional em HTML/CSS/JS puro do efeito de partículas e do card de "arquivo recebido" (canvas com partículas dissolvendo ao clicar em "destruir agora") — usar como referência de paleta, tipografia e comportamento da animação.

## Por onde começar

Sugiro dividir em etapas:
1. Servidor de sinalização (WebSocket) + geração de sala/token + QR code
2. Conexão WebRTC entre os dois peers (mesma rede primeiro, sem TURN)
3. Transferência de arquivo via `RTCDataChannel` em chunks, com verificação de integridade (hash) e preservação de metadados
4. Fallback com STUN/TURN para redes diferentes
5. Efeito de partículas aplicado ao arquivo real recebido (não só ao mock) + descarte real da sessão ao destruir
6. Polimento visual final seguindo a direção de design acima

Pode me ajudar a estruturar o repositório e começar pela etapa 1?
