'use strict';
const { describe, it } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const riftbound = require('./games/riftbound');
const onepiece = require('./games/onepiece');

describe('riftbound adapter', () => {
  it('exports the game-adapter contract', () => {
    for (const k of ['api', 'fetchOne', 'fetchById', 'fetchBatch', 'keep', 'normalize', 'power', 'theme']) {
      assert.equal(typeof riftbound[k] !== 'undefined', true, k);
    }
    assert.match(riftbound.theme.imgHosts, /openrift\.app/);
    assert.equal(riftbound.theme.toggleLabel.includes('Rift'), true);
  });

  it('keeps units and legends only', () => {
    assert.equal(riftbound.keep({ card: { types: ['unit'] } }), true);
    assert.equal(riftbound.keep({ card: { types: ['legend'] } }), true);
    assert.equal(riftbound.keep({ card: { types: ['spell'] } }), false);
    assert.equal(riftbound.keep({ card: { types: ['rune'] } }), false);
  });

  it('converts OpenRift integer cents to USD dollars (tcgplayer preferred)', () => {
    const printingId = '019cfc3b-03d2-7d0d-beec-d1b4c6382fe7';
    riftbound._setCatalogForTest(
      {
        cards: {
          'card-1': {
            name: 'Adaptatron',
            types: ['unit'],
            domains: ['calm'],
            might: 3,
            energy: 4
          }
        },
        printings: {}
      },
      { [printingId]: { tcgplayer: 26, cardmarket: 2 } }
    );
    assert.equal(riftbound._priceUsd(printingId), 0.26);

    const card = riftbound.normalize({
      printingId,
      printing: {
        rarity: 'uncommon',
        printedName: 'Adaptatron',
        images: [{ imageId: 'b27db2e7-788d-4575-9154-9b5c95b02ddd' }]
      },
      card: {
        name: 'Adaptatron',
        types: ['unit'],
        domains: ['calm'],
        might: 3,
        energy: 4
      }
    });
    assert.equal(card.id, printingId);
    assert.equal(card.name, 'Adaptatron');
    assert.equal(card.rarity, 'Uncommon');
    assert.equal(card.attr, 'Calm');
    assert.equal(card.might, 3);
    assert.equal(card.price, 0.26);
    assert.match(card.image, /^https:\/\/openrift\.app\/media\/cards\/.+-240w\.webp$/);
    assert.equal(riftbound.power(card), 3);
  });

  it('falls back to EUR markets when TCGplayer is missing', () => {
    const printingId = 'eur-only';
    riftbound._setCatalogForTest(
      { cards: {}, printings: {} },
      { [printingId]: { cardmarket: 200 } } // €2.00 in cents
    );
    const usd = riftbound._priceUsd(printingId);
    assert.ok(usd > 1.5 && usd < 3.5, 'EUR cents converted roughly to USD, got ' + usd);
  });
});

describe('onepiece adapter', () => {
  it('exports the game-adapter contract plus key/art helpers', () => {
    for (const k of ['api', 'fetchOne', 'fetchById', 'fetchBatch', 'keep', 'normalize', 'power', 'theme', 'configure', 'hasApiKey', 'persistCard', 'withArt']) {
      assert.equal(typeof onepiece[k] !== 'undefined', true, k);
    }
    assert.match(onepiece.theme.imgHosts, /api\.pokewallet\.io/);
  });

  it('package.json exposes the One Piece API key setting (never hardcoded)', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const key = manifest.contributes.configuration.properties['ygoDuel.onePiece.apiKey'];
    assert.equal(key.type, 'string');
    assert.equal(key.default, '');
    assert.match(key.description, /PokeWallet/);
    const cmds = manifest.contributes.commands.map(c => c.command).join(' ');
    assert.match(cmds, /openRiftbound/);
    assert.match(cmds, /openOnePiece/);
  });

  it('keeps cards and drops sealed / DON!!', () => {
    assert.equal(onepiece.keep({ id: 'op_1', name: 'Zoro', product_type: 'card' }), true);
    assert.equal(onepiece.keep({ id: 'op_2', name: 'Box', product_type: 'sealed' }), false);
    assert.equal(onepiece.keep({ id: 'op_3', name: 'DON!!', rarity: 'DON!!' }), false);
  });

  it('prefers TCGplayer market_price (USD) and falls back to Cardmarket EUR', () => {
    assert.equal(onepiece._priceFromCard({
      tcgplayer: { prices: { market_price: 1.76, low_price: 1.2 } },
      cardmarket: { prices: { trend: 1.7, avg: 1.64 } }
    }), 1.76);

    const eurOnly = onepiece._priceFromCard({
      tcgplayer: null,
      cardmarket: { prices: { trend: 2.0, avg: 1.5 } }
    });
    assert.ok(eurOnly > 1.5 && eurOnly < 3.5, 'EUR→USD fallback, got ' + eurOnly);
  });

  it('normalize maps rarity codes and persistCard strips data-URI art', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
    onepiece.configure({ cacheDir: dir });

    const raw = {
      id: 'op_abc123',
      name: 'Roronoa Zoro',
      rarity: 'L',
      card_type: 'Leader',
      ext_color: 'Red',
      ext_power: '5000',
      ext_cost: null,
      product_type: 'card',
      tcgplayer: { prices: { market_price: 2.06 } },
      cardmarket: { prices: { trend: 1.87 } }
    };
    const card = onepiece.normalize(raw);
    assert.equal(card.id, 'op_abc123');
    assert.equal(card.rarity, 'Leader');
    assert.equal(card.power, 5000);
    assert.equal(card.attr, 'Red');
    assert.equal(card.price, 2.06);
    assert.match(card.image, /api\.pokewallet\.io\/op\/images\/op_abc123/);

    const withData = { ...card, image: 'data:image/png;base64,aaa', imageFull: 'data:image/png;base64,aaa' };
    const stored = onepiece.persistCard(withData);
    assert.match(stored.image, /^https:\/\/api\.pokewallet\.io\/op\/images\/op_abc123$/);
    assert.equal(onepiece.power(card), 5000);
  });
});

describe('extension wires both new games', () => {
  it('registers riftbound and onepiece in GAMES', () => {
    const host = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');
    assert.match(host, /riftbound: require\('\.\/games\/riftbound'\)/);
    assert.match(host, /onepiece: require\('\.\/games\/onepiece'\)/);
    assert.match(host, /ygoDuel\.openRiftbound/);
    assert.match(host, /ygoDuel\.openOnePiece/);
    assert.match(host, /persistCard/);
  });
});
