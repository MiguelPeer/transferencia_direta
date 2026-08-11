// Troca entre paineis sobrepostos (.stage-panel) com um fade sequencial:
// esconde os outros primeiro, so entao mostra o alvo. Evita o "double
// exposure" de crossfade simultaneo quando o conteudo de dois paineis
// (textos, nomes de arquivo) se sobrepoe visualmente por uma fracao de
// segundo - mais notavel em casos raros tipo a sala ser destruida no meio
// de uma transferencia.
const FADE_MS = 200; // deve bater com a transicao de opacity em .stage-panel

export function switchPanel(panels, target) {
  // cancela qualquer troca anterior ainda pendente pro mesmo grupo - senao
  // uma chamada rapida em seguida (arquivo pequeno, troca de painel em
  // menos de FADE_MS) deixa um timer antigo reativando o painel errado
  // depois que um alvo mais novo ja foi escolhido.
  if (panels.__pendingTimer) clearTimeout(panels.__pendingTimer);

  for (const panel of panels) {
    if (panel !== target) panel.classList.remove("is-active");
  }

  if (target.classList.contains("is-active")) return;

  panels.__pendingTimer = setTimeout(() => {
    target.classList.add("is-active");
    panels.__pendingTimer = null;
  }, FADE_MS);
}
