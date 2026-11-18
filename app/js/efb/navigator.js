/* EFB · Navigator.
 *
 * The Flight Deck map itself, inside the bag: the same layers, traffic, route,
 * procedures, weather and controls, read from the same telemetry. It is loaded
 * as the Flight Deck page in its embedded mode (`index.html?embed=efb`), which
 * hides the Flight Deck's own rail and top bar so the bag's bar stays the only
 * one. There is one map to maintain, and the two can never drift apart.
 */

export const NAVIGATOR_SRC = 'index.html?embed=efb';

export async function mount(root) {
  // The page owns the whole content region: a chart, not a card on a page.
  document.body.classList.add('view-map', 'view-nav');
  root.innerHTML = `
    <div class="nav-deck">
      <iframe class="nav-deck-frame" src="${NAVIGATOR_SRC}" title="Navigator: the Flight Deck map" allow="fullscreen"></iframe>
    </div>`;
  return {
    destroy() {
      document.body.classList.remove('view-map', 'view-nav');
    },
  };
}
