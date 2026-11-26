'use strict';
// Runs last: asks who is signed in, loads the state, starts the timers.

// The installed version, from /api/health, fetched once at startup.
api('GET', '/api/health').then(function (h) {
  var v = $('app-version');
  if (v && h && h.version) v.textContent = h.version;
}).catch(function () { /* leave the placeholder */ });

api('GET', '/api/auth/status').then(function (st) {
  authInfo = { required: !!st.required, source: st.source || (st.required ? 'env' : 'none'), deployment: st.deployment || '', dataFolder: st.dataFolder || '' };
  renderLoginCard();
  renderForgot();
  renderHeaderButtons();
  if (st.required && !st.authenticated) showLogin();
  // Setup's pages depend on this computer's options; ask first (only
  // when logged in, or no login is needed).
  if (!st.required || st.authenticated) return loadDesktop();
  return null;
}).catch(function () { /* older server or offline: nothing to show */ }).then(function () {
  authKnown = true;
  syncSetup();
});

load().catch(function (e) {
  // The login screen is already up — no error notice.
  if (e.message === 'login required') return;
  if (/state\.json is (corrupt|missing)/.test(e.message)) { showStateError(e.message); return; }
  // Error text, not HTML: built with textContent so markup renders
  // literally.
  var main = document.querySelector('main');
  var notice = document.createElement('div');
  notice.className = 'notice bad';
  notice.textContent = 'Could not load Standby state: ' + e.message;
  main.insertBefore(notice, main.firstChild);
});

// Confirmations once a minute. The live view: one 1-second timer, not a
// cadence interval, so a cadence change applies at once and the countdown
// keeps ticking.
setInterval(refreshConfirmations, 60 * 1000);
setInterval(liveSecondTick, 1000);
