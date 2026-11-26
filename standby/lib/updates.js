'use strict';
// "Check for new versions" (settings.updateCheck): once a day, ask GitHub
// for the latest published release and compare it with this version. Only
// a plain GET is sent (no data about the user or the transactions; GitHub
// sees the computer's address). Default: on for the standalone downloads,
// off for Docker and plain Node; not offered on Umbrel, which updates
// apps itself. Nothing is downloaded or installed: the app only says a
// newer version exists and links to it.
const { requestText } = require('./net');
const { DEPLOYMENT, VERSION, UPDATE_URL } = require('./config');

const AVAILABLE = DEPLOYMENT !== 'umbrel';
const DEFAULT_ON = DEPLOYMENT === 'desktop';
const DAY_MS = 24 * 60 * 60 * 1000;

let last = { latest: null, url: null, checkedAt: null, error: null };
let timer = null;

function enabledFor(settings) {
  if (!AVAILABLE) return false;
  const v = settings && settings.updateCheck;
  return typeof v === 'boolean' ? v : DEFAULT_ON;
}

// "0.8.21" or "v0.8.21.1" as numbers; null when not a version.
function parse(v) {
  const m = /^v?(\d+(?:\.\d+){1,3})$/.exec(String(v || '').trim());
  return m ? m[1].split('.').map(Number) : null;
}
function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function check() {
  const u = new URL(UPDATE_URL);
  try {
    const res = await requestText({
      protocol: u.protocol, hostname: u.hostname, port: u.port ? parseInt(u.port, 10) : undefined,
      path: u.pathname + u.search, method: 'GET',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Standby/' + VERSION },
    });
    if (res.status !== 200) throw new Error('GitHub answered HTTP ' + res.status);
    const doc = JSON.parse(res.body);
    if (!parse(doc.tag_name)) throw new Error('the latest release has no version tag');
    last = { latest: String(doc.tag_name).replace(/^v/, ''), url: typeof doc.html_url === 'string' ? doc.html_url : null, checkedAt: new Date().toISOString(), error: null };
    if (newer(last.latest, VERSION)) console.log('Standby: version ' + last.latest + ' is available (this is ' + VERSION + ')');
  } catch (e) {
    last = { ...last, checkedAt: new Date().toISOString(), error: e.message };
  }
  return status(true);
}

// Start or stop the daily check to match the setting. The first check
// runs a minute after start (or at once when just switched on).
function sync(settings, soon) {
  const on = enabledFor(settings);
  if (!on) { if (timer) { clearInterval(timer); clearTimeout(timer); timer = null; } return; }
  if (timer) return;
  timer = setTimeout(function first() {
    check();
    timer = setInterval(check, DAY_MS);
    if (timer.unref) timer.unref();
  }, soon ? 0 : 60 * 1000);
  if (timer.unref) timer.unref();
}

function status(enabled) {
  return {
    available: AVAILABLE, enabled: !!enabled, current: VERSION,
    latest: last.latest, newer: !!last.latest && newer(last.latest, VERSION),
    url: last.url, checkedAt: last.checkedAt, error: last.error,
  };
}

module.exports = { AVAILABLE, enabledFor, check, sync, status, newer };
