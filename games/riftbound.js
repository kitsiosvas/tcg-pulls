/*
 * Game definition for Riftbound (via OpenRift's free API).
 *
 * Same contract as games/yugioh.js — see that file for the field-by-field
 * description of the adapter + theme.
 *
 * Data source: https://openrift.app/developers — no API key. Catalog and
 * prices are cached in memory (and refreshed on the API's daily/hourly
 * cadence) so pack opens don't re-download the multi-MB catalog.
 */

const { getJson } = require('../http');

const api = 'https://openrift.app/api/v1';
const UA = { 'User-Agent': 'tcg-pulls-vscode/0.1 (kitsios.va@gmail.com)' };
const MEDIA = 'https://openrift.app/media/cards/';

// EUR→USD rate for Cardmarket / CardTrader / CardNexus fallback prices.
// Fetched once at module load; falls back to 1.10 if the request fails.
let eurUsd = 1.10;
getJson('https://api.frankfurter.app/latest?from=EUR&to=USD', {})
  .then(json => { const r = json && json.rates && json.rates.USD; if (r > 0) eurUsd = r; })
  .catch(() => {});

const RARITY_LABEL = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  showcase: 'Showcase'
};

const DOMAIN_LABEL = {
  fury: 'Fury',
  calm: 'Calm',
  mind: 'Mind',
  body: 'Body',
  chaos: 'Chaos',
  order: 'Order',
  neutral: 'Neutral',
  colorless: 'Colorless'
};

// In-memory catalog + prices. Catalog is safe for ~1h (API max-age); prices
// update once a day — refresh both together so a printing always has a
// matching price map.
let catalog = null;       // { cards, printings, sets, enums, ... }
let prices = null;        // { [printingId]: { tcgplayer?, cardmarket?, ... } }
let catalogLoadedAt = 0;
const CATALOG_TTL_MS = 60 * 60 * 1000;

async function ensureCatalog() {
  if (catalog && prices && Date.now() - catalogLoadedAt < CATALOG_TTL_MS) return;
  const [cat, priceJson] = await Promise.all([
    getJson(api + '/catalog?langs=EN', UA),
    getJson(api + '/prices', UA)
  ]);
  if (!cat || !cat.cards || !cat.printings) throw new Error('unexpected OpenRift catalog shape');
  catalog = cat;
  prices = (priceJson && priceJson.prices) || {};
  catalogLoadedAt = Date.now();
}

/** English printings that have art, joined with their card — the pool we
 *  draw from. Pre-filtered with keep() so harvest rounds aren't mostly
 *  spells/runes. Rebuilt whenever the catalog refreshes. */
let pool = null;
let poolAt = 0;
function ensurePool() {
  if (pool && poolAt === catalogLoadedAt) return pool;
  const out = [];
  for (const [printingId, p] of Object.entries(catalog.printings)) {
    if (!p || p.language !== 'EN') continue;
    if (!p.images || !p.images[0] || !p.images[0].imageId) continue;
    const card = catalog.cards[p.cardId];
    if (!card) continue;
    const raw = { printingId, printing: p, card };
    if (!keep(raw)) continue;
    out.push(raw);
  }
  pool = out;
  poolAt = catalogLoadedAt;
  return pool;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function fetchOne() {
  await ensureCatalog();
  const list = ensurePool();
  if (!list.length) throw new Error('OpenRift catalog has no English printings');
  return pickRandom(list);
}

async function fetchBatch(count) {
  await ensureCatalog();
  const list = ensurePool();
  if (!list.length) throw new Error('OpenRift catalog has no English printings');
  const want = Math.max(1, Math.floor(Number(count) || 0));
  // Sample with replacement across the whole catalog so bulk opens aren't
  // stuck in one set — dedupe-by-name in harvest() drops exact name clashes.
  const out = [];
  for (let i = 0; i < want; i++) out.push(pickRandom(list));
  return out;
}

/** Look up one already-known printing by id — used to backfill rarity/price. */
async function fetchById(id) {
  await ensureCatalog();
  const printing = catalog.printings[id];
  if (!printing) throw new Error('card not found: ' + id);
  const card = catalog.cards[printing.cardId];
  if (!card) throw new Error('card not found: ' + id);
  return { printingId: id, printing, card };
}

/** Keep Units and Legends (the "character" cards); skip runes/spells/gear/
 *  battlefields/tokens — mirrors YGO's monsters-only / Pokémon's Pokémon-only. */
function keep(raw) {
  const types = (raw && raw.card && raw.card.types) || [];
  return types.includes('unit') || types.includes('legend');
}

/** OpenRift stores marketplace prices as integer cents in each market's own
 *  currency (tcgplayer = USD, the rest = EUR). Display currency is USD. */
function priceUsd(printingId) {
  const p = prices && prices[printingId];
  if (!p) return null;
  if (p.tcgplayer > 0) return Math.round(p.tcgplayer) / 100;
  const eurCents = [p.cardmarket, p.cardtrader, p.cardnexus].find(v => v > 0);
  if (eurCents > 0) return Math.round((eurCents / 100) * eurUsd * 100) / 100;
  return null;
}

function normalize(raw) {
  const { printingId, printing, card } = raw;
  const imageId = printing.images && printing.images[0] && printing.images[0].imageId;
  const raritySlug = printing.rarity || null;
  const rarity = raritySlug ? (RARITY_LABEL[raritySlug] || raritySlug) : null;
  const domainSlug = (card.domains && card.domains[0]) || null;
  const typeLabel = (card.types || []).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(' / ') || null;

  return {
    // Per-printing id so a Common and an Epic of the same card are distinct
    // binder slots (same idea as YGO baking rarity into the id).
    id: printingId,
    name: printing.printedName || card.name,
    image: imageId ? MEDIA + imageId + '-240w.webp' : null,
    imageFull: imageId ? MEDIA + imageId + '-400w.webp' : null,
    might: typeof card.might === 'number' ? card.might : null,
    energy: typeof card.energy === 'number' ? card.energy : null,
    attr: domainSlug ? (DOMAIN_LABEL[domainSlug] || domainSlug) : null,
    type: typeLabel,
    rarity,
    price: priceUsd(printingId)
  };
}

/** Base rarity: higher-might units reveal later. */
function power(c) {
  return c.might || 0;
}

const theme = {
  ns: 'ygoDuel',
  toggleLabel: '🌀 Rift',
  fieldTitle: '🌀 Rift Field',
  binderTitle: '📖 Rift Binder',
  drawWord: 'DRAW!',
  actionLabel: '🌀 Draw',
  itemPlural: 'units',
  imgHosts: 'https://openrift.app',
  attrIcons: {
    Fury: '🔥', Calm: '💧', Mind: '🧠', Body: '🛡️',
    Chaos: '🌪️', Order: '⚖️', Neutral: '⚪', Colorless: '✦'
  },
  attrKey: 'attr',
  stats: [ { key: 'might', label: 'MIGHT' }, { key: 'energy', label: 'ENERGY' } ],
  packTitle: 'RIFT',
  packSubtitle: 'PACK',
  packAspectRatio: '2 / 3'
};

module.exports = {
  api, fetchOne, fetchById, fetchBatch, keep, normalize, power, theme,
  // exported for unit tests
  _priceUsd: priceUsd, _setCatalogForTest(cat, priceMap) {
    catalog = cat;
    prices = priceMap || {};
    catalogLoadedAt = Date.now();
    pool = null;
  }
};
