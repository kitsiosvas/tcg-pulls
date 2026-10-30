/*
 * Shared EUR→USD rate for Cardmarket (and similar) fallback prices.
 *
 * Lazy: nothing is fetched at require() time. The first await getEurUsd()
 * hits frankfurter.app (ECB); the result is cached in memory for the rest
 * of the process. On failure the cached value is 1.10 so callers never hang
 * on FX. Sync eurUsd() returns whatever is currently cached (fallback until
 * the first getEurUsd() settles) — use it from sync normalize() after the
 * fetch path has awaited getEurUsd().
 */
const { getJson } = require('./http');

const FALLBACK = 1.10;

let rate = FALLBACK;
let resolved = false;
let inflight = null;

/** Awaitable: warm (or return) the cached EUR→USD rate. */
function getEurUsd() {
  if (resolved) return Promise.resolve(rate);
  if (!inflight) {
    inflight = getJson('https://api.frankfurter.app/latest?from=EUR&to=USD')
      .then(json => {
        const r = json && json.rates && json.rates.USD;
        rate = r > 0 ? r : FALLBACK;
        return rate;
      })
      .catch(() => {
        rate = FALLBACK;
        return rate;
      })
      .finally(() => {
        resolved = true;
        inflight = null;
      });
  }
  return inflight;
}

/** Sync peek at the cached rate (FALLBACK until the first getEurUsd settles). */
function eurUsd() {
  return rate;
}

/** Test-only: reset so the next getEurUsd() hits the network again. */
function _resetForTest() {
  rate = FALLBACK;
  resolved = false;
  inflight = null;
}

module.exports = { getEurUsd, eurUsd, _resetForTest };
