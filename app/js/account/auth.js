/* Sign in, sign up, forgot, reset and verify.
 *
 * One module serves all five pages; the page names itself with
 * <body data-auth="login">. Every form talks to the real account service —
 * there is no offline pretend-login path anywhere in this file.
 */

import * as api from './api.js';
import {
  $, $$, showAlert, hideAlert, setBusy, safeNext, guard, goTo,
  passwordScore, strengthLabel, brandMark,
} from './ui.js';

const page = document.body.dataset.auth || '';
const errorBox = $('#auth-error');
const okBox = $('#auth-ok');
const continueLink = $('#auth-continue');
const form = $('#auth-form');
const submit = $('#submit');

for (const slot of $$('[data-brand-mark]')) slot.innerHTML = brandMark();

function fail(message) {
  if (errorBox) showAlert(errorBox, 'bad', message);
  if (okBox) hideAlert(okBox);
  if (errorBox) errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function succeed(message, link) {
  if (okBox) showAlert(okBox, 'ok', message, link);
  if (errorBox) hideAlert(errorBox);
  if (okBox) okBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Success with no way back into the form: the account exists, so go forward. */
function finish(message, link, { label = 'Continue to my dashboard', href = 'account.html' } = {}) {
  succeed(message, link);
  if (form) form.querySelectorAll('input, button').forEach(node => { node.disabled = true; });
  if (submit) submit.textContent = 'Done';
  if (continueLink) {
    continueLink.href = href;
    continueLink.textContent = label;
    continueLink.hidden = false;
  }
}

const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());

for (const button of $$('[data-toggle-password]')) {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
    button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    input.focus();
  });
}

const strengthBox = $('#strength');
const passwordInput = $('#password');
if (strengthBox && passwordInput) {
  const label = $('#strength-label');
  passwordInput.addEventListener('input', () => {
    const score = passwordScore(passwordInput.value);
    strengthBox.dataset.score = String(score);
    if (label) label.textContent = passwordInput.value ? strengthLabel(score) : 'At least 10 characters';
  });
}

function readPasswordPair() {
  const first = String(passwordInput?.value || '');
  const second = String($('#password2')?.value ?? first);
  // The service requires 10; saying 8 here would promise something it refuses.
  if (first.length < 10) return { error: 'Use at least 10 characters for your password.' };
  if (second !== first) return { error: 'The two passwords do not match.' };
  return { password: first };
}

async function signIn() {
  await guard({ signedIn: false });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.busy === '1') return;
    const email = String($('#email')?.value || '').trim();
    const password = String(passwordInput?.value || '');
    if (!validEmail(email)) return fail('Enter the email address on your account.');
    if (!password) return fail('Enter your password.');

    form.dataset.busy = '1';
    hideAlert(errorBox);
    setBusy(submit, true, 'Signing in…');
    try {
      const result = await api.login({ email, password });
      const name = result?.user?.username ? `, ${result.user.username}` : '';
      succeed(`Signed in${name}. Opening your dashboard…`);
      goTo(safeNext());
    } catch (error) {
      fail(error.message);
      if (passwordInput) { passwordInput.value = ''; passwordInput.focus(); }
    } finally {
      form.dataset.busy = '';
      setBusy(submit, false);
    }
  });
}

async function signUp() {
  await guard({ signedIn: false });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.busy === '1') return;
    const username = String($('#username')?.value || '').trim();
    const email = String($('#email')?.value || '').trim();

    if (username.length < 2) return fail('Choose a username of at least 2 characters.');
    if (!validEmail(email)) return fail('Enter a valid email address.');
    const pair = readPasswordPair();
    if (pair.error) return fail(pair.error);

    form.dataset.busy = '1';
    hideAlert(errorBox);
    setBusy(submit, true, 'Creating account…');
    try {
      const result = await api.signup({ email, password: pair.password, username });
      const sent = result?.verification?.sent;
      const message = sent
        ? 'Your account is ready. We emailed a link to confirm your address.'
        : 'Your account is ready. Email delivery is not configured on this deployment yet, so the confirmation link is below.';
      finish(message, result?.verification?.devLink);
    } catch (error) {
      fail(error.message);
    } finally {
      form.dataset.busy = '';
      setBusy(submit, false);
    }
  });
}

function forgot() {
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.busy === '1') return;
    const email = String($('#email')?.value || '').trim();
    if (!validEmail(email)) return fail('Enter the email address on your account.');

    form.dataset.busy = '1';
    hideAlert(errorBox);
    setBusy(submit, true, 'Sending…');
    try {
      const result = await api.forgotPassword(email);
      const message = result?.sent
        ? 'If that address has an account, a reset link is on its way. It works once and expires in an hour.'
        : 'If that address has an account, a reset link would be sent. Email delivery is not configured here, so the link is below.';
      finish(message, result?.devLink, { label: 'Back to sign in', href: 'login.html' });
    } catch (error) {
      fail(error.message);
    } finally {
      form.dataset.busy = '';
      setBusy(submit, false);
    }
  });
}

function reset() {
  const token = new URLSearchParams(location.search).get('token') || '';
  if (!token) {
    fail('This reset link is incomplete. Request a new one from the forgot-password page.');
    if (form) form.hidden = true;
    return;
  }
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.busy === '1') return;
    const pair = readPasswordPair();
    if (pair.error) return fail(pair.error);

    form.dataset.busy = '1';
    hideAlert(errorBox);
    setBusy(submit, true, 'Saving…');
    try {
      await api.resetPassword({ token, password: pair.password });
      finish('Your password is changed and every other device is signed out.', null);
    } catch (error) {
      fail(error.message);
    } finally {
      form.dataset.busy = '';
      setBusy(submit, false);
    }
  });
}

async function verify() {
  const token = new URLSearchParams(location.search).get('token') || '';
  const box = $('#verify-state');
  if (!box) return;
  if (!token) {
    box.replaceChildren();
    const head = document.createElement('h1');
    head.textContent = 'This link is incomplete';
    const text = document.createElement('p');
    text.textContent = 'The confirmation link is missing its token. Sign in and resend the email from your dashboard.';
    const link = document.createElement('a');
    link.className = 'btn btn--primary btn--wide';
    link.href = 'login.html';
    link.textContent = 'Go to sign in';
    box.append(head, text, link);
    return;
  }
  try {
    const result = await api.verifyEmail(token);
    const address = result?.user?.email ? ` ${result.user.email}` : '';
    box.replaceChildren();
    const head = document.createElement('h1');
    head.textContent = 'Address confirmed';
    const text = document.createElement('p');
    text.textContent = `Thanks —${address} is now a verified Stratos address.`;
    const link = document.createElement('a');
    link.className = 'btn btn--primary btn--wide';
    link.href = api.savedToken() ? 'account.html' : 'login.html';
    link.textContent = api.savedToken() ? 'Open my dashboard' : 'Sign in';
    box.append(head, text, link);
  } catch (error) {
    box.replaceChildren();
    const head = document.createElement('h1');
    head.textContent = 'That link did not work';
    const text = document.createElement('p');
    text.textContent = error.message;
    const link = document.createElement('a');
    link.className = 'btn btn--ghost btn--wide';
    link.href = 'login.html';
    link.textContent = 'Sign in and resend';
    box.append(head, text, link);
  }
}

const pages = { login: signIn, signup: signUp, forgot, reset, verify };
const start = pages[page];
if (start) start();

export { page };
