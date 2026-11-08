/* The sign-in landing page.
 *
 * It offers exactly two ways forward — sign in or create an account — and it
 * never lets a signed-in visitor look at them: a saved token is checked with
 * the service first, so a revoked session lands on the choices rather than
 * bouncing off the gate on the next page.
 */
import * as api from './api.js';
import { safeNext, brandMark } from './ui.js';

for (const slot of document.querySelectorAll('[data-brand-mark]')) slot.innerHTML = brandMark();

// Whatever destination the gate sent us here for is carried into both choices,
// so signing in from a deep link still lands where the pilot was going.
const next = safeNext('index.html');
for (const link of document.querySelectorAll('[data-next-into]')) {
  const target = link.dataset.nextInto;
  if (target) link.setAttribute('href', `${target}?next=${encodeURIComponent(next)}`);
}

// A pilot who is not ready to make an account can still fly: the choice is
// remembered on this device, and Settings offers the account again later.
document.getElementById('skip-signin')?.addEventListener('click', () => {
  try { localStorage.setItem('stratos.account.skipped', '1'); } catch (_) { /* private mode */ }
  location.assign(next);
});

async function skipWhenSignedIn() {
  if (!api.savedToken()) return;
  try {
    const user = await api.session();
    if (user) {
      try { localStorage.removeItem('stratos.account.skipped'); } catch (_) { /* private mode */ }
      location.replace(next);
      return;
    }
  } catch (error) {
    // A rejected token is cleared; the choices stay on screen. A network
    // failure also leaves the choices: they are still the right next step.
    if (error && error.status === 401) api.forgetToken();
  }
}

skipWhenSignedIn();
