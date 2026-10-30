/*
 * Game definition for One Piece Card Game (via OPTCG API).
 *
 * Same contract as games/yugioh.js — see that file for the field-by-field
 * description of the adapter + theme.
 *
 * Data source: https://optcgapi.com/documentation — free, no API key.
 *   GET /api/allSets/              — booster set list
 *   GET /api/sets/{set_id}/        — all cards in a set (incl. Parallel arts)
 *   GET /api/sets/card/{card_id}/  — every printing of one card_set_id
 *   GET /api/allSetCards/          — every booster card (cached in memory)
 *   GET /api/allDecks/, /api/allSTCards/, /api/decks/{st_id}/ — starters
 *
 * Prices are USD TCGplayer scrapes (market_price / inventory_price), updated
 * daily. card_image is a public CDN URL the webview can load directly.
 */

const { getJson } = require('../http');

const api = 'https://optcgapi.com/api';

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
  Black: '⚫', Yellow: '🟡'
};

// Light in-memory cache (same idea as Riftbound's catalog cache). Prices
// update daily; refreshing hourly is plenty and keeps traffic light.
let pool = null;       // raw cards we can draw from
let byImageId = null;  // Map card_image_id → raw card (for fetchById)
let loadedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

async function ensurePool() {
  if (pool && Date.now() - loadedAt < CACHE_TTL_MS) return;
  // allSetCards covers every booster printing (incl. Parallels). Starter-deck
  // cards fill in ST-only printings the boosters don't repeat.
  const [setCards, stCards] = await Promise.all([
    getJson(api + '/allSetCards/'),
    getJson(api + '/allSTCards/').catch(() => [])
  ]);
  const list = []
    .concat(Array.isArray(setCards) ? setCards : [])
    .concat(Array.isArray(stCards) ? stCards : []);
  if (!list.length) throw new Error('unexpected OPTCG catalog shape');

  const map = new Map();
  const kept = [];
  for (const c of list) {
    if (!c || !c.card_name || !c.card_image_id) continue;
    // Later sources win on the same image id (starters rarely collide).
    map.set(c.card_image_id, c);
  }
  for (const c of map.values()) {
    if (keep(c)) kept.push(c);
  }
  if (!kept.length) throw new Error('OPTCG catalog has no draw-able cards');
  pool = kept;
  byImageId = map;
  loadedAt = Date.now();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function fetchOne() {
  await ensurePool();
  return pickRandom(pool);
}

async function fetchBatch(count) {
  await ensurePool();
  const want = Math.max(1, Math.floor(Number(count) || 0));
  const out = [];
  for (let i = 0; i < want; i++) out.push(pickRandom(pool));
  return out;
}

/** Look up one already-known printing by card_image_id (binder id). Falls
 *  back to /sets/card/{card_set_id}/ when the cache is cold or misses. */
async function fetchById(id) {
  await ensurePool();
  if (byImageId && byImageId.has(id)) return byImageId.get(id);

  // Parallel arts use OP01-001_p1 — strip the suffix to hit the by-set-id route.
  const base = String(id).replace(/_p\d+$/i, '');
  const printings = await getJson(api + '/sets/card/' + encodeURIComponent(base) + '/');
  const list = Array.isArray(printings) ? printings : [];
  const hit = list.find(c => c && c.card_image_id === id) || list[0];
  if (!hit || !hit.card_name) {
    // Starter-deck-only ids (ST01-016) live under /decks/card/
    const deckPrintings = await getJson(api + '/decks/card/' + encodeURIComponent(base) + '/').catch(() => []);
    const dlist = Array.isArray(deckPrintings) ? deckPrintings : [];
    const dhit = dlist.find(c => c && c.card_image_id === id) || dlist[0];
    if (!dhit || !dhit.card_name) throw new Error('card not found: ' + id);
    return dhit;
  }
  return hit;
}

/** Keep Leaders and Characters (the "face" cards); skip Events / DON!!. */
function keep(c) {
  if (!c || !c.card_name) return false;
  const t = c.card_type;
  return t === 'Character' || t === 'Leader';
}

/** USD from TCGplayer scrapes. Prefer market_price; fall back to inventory. */
function priceFromCard(c) {
  const market = Number(c && c.market_price);
  if (market > 0) return Math.round(market * 100) / 100;
  const inv = Number(c && c.inventory_price);
  if (inv > 0) return Math.round(inv * 100) / 100;
  return null;
}

function normalize(c) {
  const rarityCode = c.rarity || null;
  const rarity = rarityCode ? (RARITY_LABEL[rarityCode] || rarityCode) : null;
  const powerVal = c.card_power != null && c.card_power !== '' ? Number(c.card_power) : null;
  const costVal = c.card_cost != null && c.card_cost !== '' ? Number(c.card_cost) : null;
  // Parallel variants share card_set_id — card_image_id is the unique printing.
  const id = c.card_image_id || c.card_set_id || c.card_name;

  return {
    id,
    name: c.card_name,
    image: c.card_image || null,
    imageFull: c.card_image || null,
    power: Number.isFinite(powerVal) ? powerVal : null,
    cost: Number.isFinite(costVal) ? costVal : null,
    attr: c.card_color || null,
    type: c.card_type || null,
    rarity,
    price: priceFromCard(c)
  };
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
  imgHosts: 'https://optcgapi.com',
  attrIcons: COLOR_ICONS,
  attrKey: 'attr',
  stats: [ { key: 'power', label: 'POWER' }, { key: 'cost', label: 'COST' } ],
  packTitle: 'OPCG',
  packSubtitle: 'PACK',
  packAspectRatio: '2 / 3'
};

module.exports = {
  api, fetchOne, fetchById, fetchBatch, keep, normalize, power, theme,
  // test helpers
  _priceFromCard: priceFromCard,
  _setPoolForTest(cards) {
    const map = new Map();
    const kept = [];
    for (const c of cards || []) {
      if (!c || !c.card_image_id) continue;
      map.set(c.card_image_id, c);
      if (keep(c)) kept.push(c);
    }
    pool = kept;
    byImageId = map;
    loadedAt = Date.now();
  }
};
