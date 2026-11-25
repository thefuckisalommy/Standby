'use strict';
// Minimal HTTP(S) client for node, price and Slipstream requests.
const http = require('http');
const https = require('https');

const MAX_RESPONSE_BYTES = 1024 * 1024; // node and price replies are small; anything bigger is a faulty endpoint
const NET_TIMEOUT_MS = 15000;

// A wall-clock deadline guards every call: the
// socket timeout does not fire during a stalled TLS handshake, and a hung
// request would stall the release evaluation and the tick.
function requestText({ protocol, hostname, port, path: p, method, headers, body, timeoutMs }) {
  const timeout = timeoutMs || NET_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req.destroy(err); } catch { /* already gone */ }
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error('request timed out after ' + timeout + 'ms')),
      timeout,
    );
    if (timer.unref) timer.unref(); // don't keep the process alive for this alone
    const lib = protocol === 'https:' ? https : http;
    const req = lib.request(
      { hostname, port, path: p, method, headers },
      (res) => {
        const chunks = [];
        let received = 0;
        res.on('data', (c) => {
          received += c.length;
          // Cap the body size: a faulty or hostile endpoint could
          // otherwise grow the process without bound (the timeout limits
          // time, not size).
          if (received > MAX_RESPONSE_BYTES) {
            return fail(new Error('response exceeded ' + MAX_RESPONSE_BYTES + ' bytes'));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('timeout', () => fail(new Error('request timed out after ' + timeout + 'ms')));
    req.on('error', fail);
    req.setTimeout(timeout); // secondary signal; the wall-clock timer is the real guard
    if (body !== undefined) req.write(body);
    req.end();
  });
}

module.exports = { requestText, NET_TIMEOUT_MS };
