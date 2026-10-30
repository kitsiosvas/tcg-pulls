/*
 * Game definition for One Piece Card Game (via PokeWallet / BerryWallet).
 *
 * Same contract as games/yugioh.js — see that file for the field-by-field
 * description of the adapter + theme.
 *
 * Data source: https://pokewallet.io/api-docs/one-piece.md
 *   Base https://api.pokewallet.io/op  — header X-API-Key
 *   Free tier: 100 req/hour, 1,000/day. Prices refresh daily; we cache them
 *   (and card art) on disk so pack opens don't burn the quota.
 *
 * The API key is NOT hardcoded: the user pastes their own into the
 * `ygoDuel.onePiece.apiKey` setting. Opening One Piece mode without a key
 * shows a clear message pointing at that setting.
 */

const fs = require('fs');
const path = require('path');
const { getJson, getBuffer } = require('../http');

// vscode is unavailable under plain `node --test`; fall back to env so the
// pure helpers (normalize / price) still unit-test without the extension host.
let vscode = null;
try { vscode = require('vscode'); } catch { /* not in the extension host */ }

const api = 'https://api.pokewallet.io/op';
const IMG_HOST = 'https://api.pokewallet.io';

// EUR→USD rate for Cardmarket fallback prices.
let eurUsd = 1.10;
getJson('https://api.frankfurter.app/latest?from=EUR&to=USD', {})
  .then(json => { const r = json && json.rates && json.rates.USD; if (r > 0) eurUsd = r; })
  .catch(() => {});

const RARITY_LABEL = {
  C: 'Common',
  UC: 'Uncommon',
  R: 'Rare',
  SR: 'Super Rare',
  SEC: 'Secret Rare',
  L: 'Leader',
  SP: 'Special',
  'DON!!': 'DON!!'
};

const COLOR_ICONS = {
  Red: '🔴', Green: '🟢', Blue: '🔵', Purple: '🟣',
  Black: '⚫', Yellow: '🟡', Multicolor: '🌈'
};

let cacheDir = null; // set via configure() from extension activate
let missingKeyWarned = false;

function configure({ cacheDir: dir } = {}) {
  if (dir) {
    cacheDir = dir;
    try { fs.mkdirSync(path.join(cacheDir, 'images'), { recursive: true }); } catch { /* best-effort */ }
    try { fs.mkdirSync(path.join(cacheDir, 'meta'), { recursive: true }); } catch { /* best-effort */ }
  }
}

function getApiKey() {
  if (vscode) {
    const key = vscode.workspace.getConfiguration('ygoDuel').get('onePiece.apiKey');
    return (typeof key === 'string' ? key : '').trim();
  }
  return (process.env.YGO_DUEL_ONEPIECE_API_KEY || '').trim();
}

function hasApiKey() {
  return !!getApiKey();
}

/** Show once per session when One Piece is used without a key. */
function warnMissingKey() {
  if (missingKeyWarned || !vscode) return;
  missingKeyWarned = true;
  vscode.window.showWarningMessage(
    'One Piece mode needs a free PokeWallet API key. ' +
    'Open Settings and paste it into “YGO Duel Mode › One Piece: Api Key” ' +
    '(get one at https://pokewallet.io — 100 requests/hour on the free plan).',
    'Open Settings'
  ).then(choice => {
    if (choice === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'ygoDuel.onePiece.apiKey');
    }
  });
}

function keyHeaders() {
  const key = getApiKey();
  if (!key) {
    warnMissingKey();
    const err = new Error('One Piece API key missing — set ygoDuel.onePiece.apiKey in Settings');
    err.code = 'MISSING_API_KEY';
    throw err;
  }
  return { 'X-API-Key': key };
}

function priceCachePath() {
  return path.join(cacheDir || require('os').tmpdir(), 'meta', 'prices.json');
}
function setsCachePath() {
  return path.join(cacheDir || require('os').tmpdir(), 'meta', 'sets.json');
}
function imagePathFor(id) {
  // sanitize: op_ ids are hex after the prefix; still flatten path separators
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cacheDir || require('os').tmpdir(), 'images', safe + '.bin');
}
function imageMetaPathFor(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cacheDir || require('os').tmpdir(), 'images', safe + '.type');
}

const PRICE_TTL_MS = 24 * 60 * 60 * 1000; // prices update once a day
const SETS_TTL_MS = 24 * 60 * 60 * 1000;

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}
function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch { /* best-effort */ }
}

/** Price cache: { updatedAt, byId: { [id]: { price, rarity, name, ...raw bits } } } */
function loadPriceCache() {
  const data = readJsonFile(priceCachePath());
  if (!data || !data.byId || !data.updatedAt) return { updatedAt: 0, byId: {} };
  return data;
}
function savePriceCache(cache) {
  writeJsonFile(priceCachePath(), cache);
}

function cachedPriceEntry(id) {
  const cache = loadPriceCache();
  if (Date.now() - cache.updatedAt > PRICE_TTL_MS) return null;
  return cache.byId[id] || null;
}

function putPriceEntry(id, entry) {
  const cache = loadPriceCache();
  // Rolling window: if the file is older than TTL, start a fresh day-bucket
  // so stale entries from yesterday don't linger forever.
  if (Date.now() - cache.updatedAt > PRICE_TTL_MS) {
    cache.byId = {};
    cache.updatedAt = Date.now();
  } else if (!cache.updatedAt) {
    cache.updatedAt = Date.now();
  }
  cache.byId[id] = entry;
  savePriceCache(cache);
}

async function loadSets() {
  const cached = readJsonFile(setsCachePath());
  if (cached && cached.updatedAt && Date.now() - cached.updatedAt < SETS_TTL_MS && Array.isArray(cached.sets) && cached.sets.length) {
    return cached.sets;
  }
  const json = await getJson(api + '/sets?language=en', keyHeaders());
  const sets = json && Array.isArray(json.data) ? json.data : [];
  // Prefer English TCG sets (positive group_id); fall back to whatever we got.
  const usable = sets.filter(s => s && s.set_code && Number(s.group_id) > 0);
  const list = usable.length ? usable : sets.filter(s => s && s.set_code);
  writeJsonFile(setsCachePath(), { updatedAt: Date.now(), sets: list });
  return list;
}

/** Display currency is USD. Prefer TCGplayer market_price; fall back to
 *  Cardmarket trend/avg converted EUR→USD — same idea as Pokémon mode. */
function priceFromCard(c) {
  const tcg = c && c.tcgplayer && c.tcgplayer.prices;
  const tcgMarket = tcg && Number(tcg.market_price);
  if (tcgMarket > 0) return Math.round(tcgMarket * 100) / 100;

  const cm = c && c.cardmarket && c.cardmarket.prices;
  const cmEur = cm && (cm.trend > 0 ? Number(cm.trend) : cm.avg > 0 ? Number(cm.avg) : null);
  if (cmEur > 0) return Math.round(cmEur * eurUsd * 100) / 100;
  return null;
}

function apiImageUrl(id) {
  return IMG_HOST + '/op/images/' + encodeURIComponent(id);
}

/** Read a previously downloaded art file as a data URI for the webview.
 *  Authenticated image routes can't be used as bare <img src>, so we inline. */
function artDataUri(id) {
  try {
    const file = imagePathFor(id);
    if (!fs.existsSync(file)) return null;
    const buf = fs.readFileSync(file);
    if (!buf.length) return null;
    let type = 'image/webp';
    try { type = fs.readFileSync(imageMetaPathFor(id), 'utf8').trim() || type; } catch { /* default */ }
    // content-type may include "; charset=…" — keep the media type only
    type = String(type).split(';')[0].trim() || 'image/webp';
    return 'data:' + type + ';base64,' + buf.toString('base64');
  } catch {
    return null;
  }
}

async function ensureArt(id) {
  const existing = artDataUri(id);
  if (existing) return existing;
  try {
    const res = await getBuffer(api + '/images/' + encodeURIComponent(id), keyHeaders());
    fs.mkdirSync(path.dirname(imagePathFor(id)), { recursive: true });
    fs.writeFileSync(imagePathFor(id), res.buffer);
    fs.writeFileSync(imageMetaPathFor(id), (res.contentType || 'image/webp').split(';')[0].trim());
    return artDataUri(id);
  } catch {
    return null; // art is optional — the Field falls back to the emoji card
  }
}

/** Fetch full card detail (prices) — uses the daily price cache when warm. */
async function fetchCardDetail(id) {
  const hit = cachedPriceEntry(id);
  if (hit && hit.raw) return hit.raw;

  const json = await getJson(api + '/cards/' + encodeURIComponent(id), keyHeaders());
  // Detail endpoint returns the card at the top level (sometimes wrapped).
  const c = json && json.id ? json : (json && json.data && json.data.id ? json.data : null);
  if (!c || !c.id) throw new Error('unexpected One Piece card shape');

  putPriceEntry(id, {
    price: priceFromCard(c),
    rarity: c.rarity || null,
    name: c.name,
    raw: c
  });
  return c;
}

async function fetchSetPage(setCode) {
  // Listings often ship with empty price objects on the free tier — we only
  // use them for ids/names/rarities, then enrich via /op/cards/:id (+ cache).
  const page = 1 + Math.floor(Math.random() * 4); // first few pages cover most sets
  const json = await getJson(
    api + '/sets/' + encodeURIComponent(setCode) + '?page=' + page + '&limit=50',
    keyHeaders()
  );
  const data = json && Array.isArray(json.data) ? json.data : [];
  return data.filter(c => c && c.id && c.product_type !== 'sealed');
}

async function fetchOne() {
  const sets = await loadSets();
  if (!sets.length) throw new Error('no One Piece sets returned');
  const set = sets[Math.floor(Math.random() * sets.length)];
  const page = await fetchSetPage(set.set_code);
  if (!page.length) throw new Error('empty set page: ' + set.set_code);
  const stub = page[Math.floor(Math.random() * page.length)];
  const detail = await fetchCardDetail(stub.id);
  // Prefer listing rarity/name when detail is sparse; detail wins on prices.
  const raw = { ...stub, ...detail, id: detail.id || stub.id };
  await ensureArt(raw.id);
  return raw;
}

async function fetchBatch(count) {
  const want = Math.max(1, Math.floor(Number(count) || 0));
  const sets = await loadSets();
  if (!sets.length) throw new Error('no One Piece sets returned');

  // One set page (~50 cards) covers a whole buffer refill; we only pay for
  // /op/cards/:id on cache misses. Cap parallel detail fetches to stay under
  // the free 100/hour ceiling even on a cold cache.
  const set = sets[Math.floor(Math.random() * sets.length)];
  let page = await fetchSetPage(set.set_code);
  if (page.length < want && sets.length > 1) {
    const other = sets[Math.floor(Math.random() * sets.length)];
    page = page.concat(await fetchSetPage(other.set_code));
  }
  if (!page.length) return [];

  // Shuffle then take what we need
  for (let i = page.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [page[i], page[j]] = [page[j], page[i]];
  }
  const picks = page.slice(0, Math.min(want, page.length));

  const DETAIL_CONCURRENCY = 4;
  const out = [];
  for (let i = 0; i < picks.length; i += DETAIL_CONCURRENCY) {
    const chunk = picks.slice(i, i + DETAIL_CONCURRENCY);
    const got = await Promise.all(chunk.map(async stub => {
      try {
        const detail = await fetchCardDetail(stub.id);
        const raw = { ...stub, ...detail, id: detail.id || stub.id };
        await ensureArt(raw.id);
        return raw;
      } catch {
        return null;
      }
    }));
    for (const c of got) if (c) out.push(c);
  }
  return out;
}

async function fetchById(id) {
  // Collection ids are the bare op_ id. Strip a possible " · rarity" suffix
  // if a future normalize ever bakes rarity in (YGO-style) — today it doesn't.
  const bare = String(id).split(' · ')[0];
  const detail = await fetchCardDetail(bare);
  await ensureArt(detail.id);
  return detail;
}

/** Keep real cards; drop sealed products and DON!! markers. */
function keep(c) {
  if (!c || !c.name || !c.id) return false;
  if (c.product_type === 'sealed') return false;
  if (c.card_type === 'DON!!' || c.rarity === 'DON!!') return false;
  return true;
}

function normalize(c) {
  const id = c.id;
  const rarityCode = c.rarity || null;
  const rarity = rarityCode ? (RARITY_LABEL[rarityCode] || rarityCode) : null;
  const powerVal = c.ext_power != null && c.ext_power !== '' ? Number(c.ext_power) : null;
  const costVal = c.ext_cost != null && c.ext_cost !== '' ? Number(c.ext_cost) : null;
  const art = artDataUri(id); // disk cache filled by fetchOne/fetchBatch/fetchById
  // Canonical (non-data) URL keeps cardBelongsToGame working after persistCard
  // strips the inlined art back to this host.
  const apiUrl = apiImageUrl(id);

  // Prefer a price already on the object (detail or warm cache); otherwise
  // try the daily price cache entry.
  let price = priceFromCard(c);
  if (price == null) {
    const hit = cachedPriceEntry(id);
    if (hit && hit.price > 0) price = hit.price;
  }

  return {
    id,
    name: c.name,
    image: art || apiUrl,
    imageFull: art || apiUrl,
    power: Number.isFinite(powerVal) ? powerVal : null,
    cost: Number.isFinite(costVal) ? costVal : null,
    attr: c.ext_color || null,
    type: c.card_type || null,
    rarity,
    price
  };
}

/** Drop inlined data-URI art before writing to globalState — collections keep
 *  the API image URL; withArt() re-inlines from the disk cache on display. */
function persistCard(card) {
  if (!card || !card.id) return card;
  const url = apiImageUrl(card.id);
  return { ...card, image: url, imageFull: url };
}

/** Re-inline cached art for the webview (draw / pack / binder / prefetch). */
function withArt(card) {
  if (!card || !card.id) return card;
  const art = artDataUri(card.id);
  if (!art) return card;
  return { ...card, image: art, imageFull: art };
}

/** Base rarity: higher Power characters reveal later. */
function power(c) {
  return c.power || 0;
}

const theme = {
  ns: 'ygoDuel',
  toggleLabel: '🏴‍☠️ OP',
  fieldTitle: '🏴‍☠️ One Piece Field',
  binderTitle: '📖 One Piece Binder',
  drawWord: 'DRAW!',
  actionLabel: '🏴‍☠️ Draw',
  itemPlural: 'cards',
  // Authenticated art is inlined as data: URIs; the API host is listed so
  // persisted collection entries (which store the API image URL) still pass
  // cardBelongsToGame after a reload.
  imgHosts: IMG_HOST,
  attrIcons: COLOR_ICONS,
  attrKey: 'attr',
  stats: [ { key: 'power', label: 'POWER' }, { key: 'cost', label: 'COST' } ],
  packTitle: 'OPCG',
  packSubtitle: 'PACK',
  packAspectRatio: '2 / 3'
};

module.exports = {
  api, configure, hasApiKey, warnMissingKey,
  fetchOne, fetchById, fetchBatch, keep, normalize, power, theme,
  persistCard, withArt,
  // test helpers
  _priceFromCard: priceFromCard, _putPriceEntry: putPriceEntry, _cachedPriceEntry: cachedPriceEntry
};
