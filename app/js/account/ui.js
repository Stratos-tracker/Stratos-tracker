/* Small shared helpers for the account pages.
 *
 * Everything that reaches the DOM from the network goes through textContent or
 * an explicitly built element: no user-controlled string is ever parsed as
 * HTML. The only markup set with innerHTML is this module's own icon set.
 */

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function $(selector, root = document) {
  return root ? root.querySelector(selector) : null;
}

export function $$(selector, root = document) {
  return root ? [...root.querySelectorAll(selector)] : [];
}

const ICON = {
  plane: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 15.5v-1.8l-7.6-4.4V4.6a1.4 1.4 0 0 0-2.8 0v4.7L3 13.7v1.8l7.6-2.3v4.2l-2.2 1.5v1.4l3.6-1 3.6 1v-1.4l-2.2-1.5v-4.2z"/></svg>',
};

export function brandMark() {
  return ICON.plane;
}

/** A message with an optional one link, assembled as nodes so nothing is parsed. */
export function showAlert(element, kind, message, link) {
  if (!element) return;
  element.className = `alert alert--${kind || 'info'}`;
  element.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  element.appendChild(text);
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = 'Open the link';
    anchor.style.marginLeft = '8px';
    element.appendChild(anchor);
  }
  element.hidden = false;
}

export function hideAlert(element) {
  if (!element) return;
  element.hidden = true;
  element.replaceChildren();
}

/** Disable a button and show a spinner without changing its width. */
export function setBusy(button, busy, busyLabel = 'Working…') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.replaceChildren();
    const spinner = document.createElement('i');
    spinner.className = 'spinner';
    const label = document.createElement('span');
    label.textContent = busyLabel;
    button.append(spinner, label);
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.idleLabel) button.innerHTML = button.dataset.idleLabel;
  }
}

/**
 * A next= target is only honoured when it is a path on this site. An absolute
 * URL, a protocol-relative URL or anything with a scheme is discarded, so the
 * login page can never be used as an open redirect.
 */
export function safeNext(fallback = 'index.html') {
  let raw = '';
  try { raw = new URLSearchParams(location.search).get('next') || ''; } catch (_) { raw = ''; }
  if (!raw) return fallback;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return fallback;
  if (raw.startsWith('//') || raw.startsWith('\\')) return fallback;
  if (!/^[\w./#?=&%-]+$/.test(raw)) return fallback;
  return raw;
}

export function goTo(url) {
  location.assign(url);
}

/** Send a signed-in visitor away from an auth page, and a stranger to sign in. */
export async function guard({ signedIn, next = 'index.html', login = 'auth.html' } = {}) {
  const api = await import('./api.js');
  if (!api.savedToken()) {
    if (signedIn) goTo(`${login}?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`);
    return null;
  }
  try {
    const user = await api.session();
    if (!user) {
      if (signedIn) goTo(`${login}?next=${encodeURIComponent(location.pathname.split('/').pop() + location.search)}`);
      return null;
    }
    if (!signedIn) goTo(next);
    return user;
  } catch (error) {
    if (error && error.status === 401) {
      api.forgetToken();
      if (signedIn) goTo(login);
      return null;
    }
    // A network failure on a public page is not a reason to redirect; the form
    // is still usable and its own request will report the problem.
    return null;
  }
}

export function initials(name, email) {
  const source = String(name || email || '?').trim();
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/** Paint an avatar element with the saved picture, or the user's initials. */
export function paintAvatar(element, user, { size = '' } = {}) {
  if (!element) return;
  element.className = `avatar${size ? ` avatar--${size}` : ''}`;
  element.replaceChildren();
  const avatar = user && user.avatar ? String(user.avatar) : '';
  if (avatar.startsWith('data:image/')) {
    const image = document.createElement('img');
    image.src = avatar;
    image.alt = '';
    image.loading = 'lazy';
    element.appendChild(image);
    return;
  }
  element.textContent = initials(user && user.username, user && user.email);
}

/** 2.5 h -> "2h 30m", 0 -> "0h". */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatHours(seconds) {
  const hours = (Number(seconds) || 0) / 3600;
  if (!hours) return '0.0';
  if (hours >= 1000) return Math.round(hours).toLocaleString('en-US');
  return hours.toFixed(1);
}

export function formatNumber(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export function formatDate(ms) {
  const value = Number(ms);
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function timeAgo(ms) {
  const value = Number(ms);
  if (!value) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function passwordScore(password) {
  const value = String(password || '');
  let score = 0;
  if (value.length >= 10) score++;
  if (value.length >= 14) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
  if (!value) return 0;
  return Math.max(1, Math.min(4, score));
}

export function strengthLabel(score) {
  return ['', 'Weak', 'Fair', 'Good', 'Strong'][score] || '';
}

/** Read a picture, crop it square and shrink it before it is sent anywhere. */
export function shrinkImage(file, size = 160) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      reject(new Error('Choose a PNG, JPEG or WebP image.'));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error('That image is over 8 MB. Choose a smaller one.'));
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      } catch (_) {
        reject(new Error('That image could not be prepared. Try another one.'));
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file could not be read as an image.'));
    };
    image.src = url;
  });
}
