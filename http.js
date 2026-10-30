/*
 * Tiny GET-JSON helper over Node's built-in https — deliberately NOT the global
 * fetch().
 *
 * Why not fetch(): inside VS Code's extension host the classic https module
 * picks up the OS / corporate certificate store (VS Code injects it), while
 * undici — which backs the global fetch() — does not. So behind a TLS-inspecting
 * corporate proxy, fetch() throws SELF_SIGNED_CERT_IN_CHAIN on any host the
 * proxy re-signs, while https keeps working. github.js already uses https for
 * exactly this reason; the card adapters route through here so draws work in
 * those environments too.
 *
 * Every request carries a socket-inactivity timeout (REQUEST_TIMEOUT_MS, per
 * redirect hop) so a hung connection rejects instead of stalling callers forever.
 */
const https = require('https');

const MAX_REDIRECTS = 3;
/** Socket-inactivity timeout per request (per redirect hop). Without one, a
 *  hung socket never settles: the caller awaits forever, and anything gated
 *  on that promise (the buffer's single refill loop, the pack lock) is stuck
 *  until reload. */
const REQUEST_TIMEOUT_MS = 15000;

const DEFAULT_UA = 'tcg-pulls-vscode/0.1 (kitsios.va@gmail.com)';

/** Low-level GET. `json: true` parses JSON; otherwise returns
 *  `{ buffer, contentType, statusCode }`. Follows up to MAX_REDIRECTS 3xx
 *  redirects (fetch did this for us; https doesn't). Rejects on non-2xx,
 *  non-JSON (when json), transport error, or `timeoutMs` of socket
 *  inactivity — the .cause on a TLS failure carries the real code
 *  (e.g. SELF_SIGNED_CERT_IN_CHAIN). */
function request(url, { headers = {}, redirectsLeft = MAX_REDIRECTS, timeoutMs = REQUEST_TIMEOUT_MS, json = true } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (err) { reject(err); return; }
    const req = https.request(u, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: json ? 'application/json' : '*/*',
        ...headers
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain so the socket frees
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        resolve(request(new URL(res.headers.location, u).toString(), {
          headers, redirectsLeft: redirectsLeft - 1, timeoutMs, json
        }));
        return;
      }
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        const buffer = Buffer.concat(chunks);
        if (!json) {
          resolve({
            buffer,
            contentType: res.headers['content-type'] || 'application/octet-stream',
            statusCode: res.statusCode
          });
          return;
        }
        try { resolve(JSON.parse(buffer.toString('utf8'))); }
        catch (err) { reject(new Error('non-JSON response: ' + err.message)); }
      });
    });
    req.on('error', reject);
    // destroy(err) surfaces as the 'error' event above, so the same reject path
    // handles it whether the socket hung before or during the response body
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
    req.end();
  });
}

/** GET a URL and parse JSON. */
function getJson(url, headers = {}, redirectsLeft = MAX_REDIRECTS, timeoutMs = REQUEST_TIMEOUT_MS) {
  return request(url, { headers, redirectsLeft, timeoutMs, json: true });
}

/** GET a URL and return raw bytes + content type (for card art that needs an
 *  authenticated download rather than a public CDN URL). */
function getBuffer(url, headers = {}, redirectsLeft = MAX_REDIRECTS, timeoutMs = REQUEST_TIMEOUT_MS) {
  return request(url, { headers, redirectsLeft, timeoutMs, json: false });
}

module.exports = { getJson, getBuffer };
