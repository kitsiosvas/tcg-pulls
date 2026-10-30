'use strict';
const { describe, it } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const fx = require('./fx');
const { cardBelongsToGame } = require('./card-belongs');
const riftbound = require('./games/riftbound');
const onepiece = require('./games/onepiece');
const yugioh = require('./games/yugioh');
const pokemon = require('./games/pokemon');

const GAMES_FIXTURE = { yugioh, pokemon, riftbound, onepiece };

describe('cardBelongsToGame', () => {
  it('drops a card whose image URL belongs to another game', () => {
    const ygoCard = { name: 'Dark Magician', image: 'https://images.ygoprodeck.com/images/cards/46986414.jpg' };
    assert.equal(cardBelongsToGame(ygoCard, pokemon, GAMES_FIXTURE), false);
    assert.equal(cardBelongsToGame(ygoCard, yugioh, GAMES_FIXTURE), true);
  });

  it('keeps a card whose image URL is an unknown / future CDN host', () => {
    const moved = {
      name: 'Adaptatron',
      image: 'https://cdn.example.com/riftbound/cards/adaptatron.webp'
    };
    assert.equal(cardBelongsToGame(moved, riftbound, GAMES_FIXTURE), true);
    assert.equal(cardBelongsToGame(moved, onepiece, GAMES_FIXTURE), true);
  });

  it('keeps cards with no art and cards on their own imgHosts', () => {
    assert.equal(cardBelongsToGame({ name: 'Old' }, riftbound, GAMES_FIXTURE), true);
    const op = { name: 'Zoro', image: 'https://optcgapi.com/media/static/Card_Images/OP01-001.jpg' };
    assert.equal(cardBelongsToGame(op, onepiece, GAMES_FIXTURE), true);
  });
});

describe('fx.getEurUsd', () => {
  it('does not hit the network at require time and falls back to 1.10 until resolved', () => {
    fx._resetForTest();
    assert.equal(fx.eurUsd(), 1.10);
  });

  it('caches a positive rate after the first await', async () => {
    fx._resetForTest();
    const rate = await fx.getEurUsd();
    assert.ok(rate > 0, 'rate should be positive, got ' + rate);
    assert.equal(fx.eurUsd(), rate);
    // Second call returns the same cached value without depending on a new fetch.
    assert.equal(await fx.getEurUsd(), rate);
  });
});

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

describe('onepiece adapter (OPTCG API)', () => {
  it('exports the game-adapter contract (no API-key helpers)', () => {
    for (const k of ['api', 'fetchOne', 'fetchById', 'fetchBatch', 'keep', 'normalize', 'power', 'theme']) {
      assert.equal(typeof onepiece[k] !== 'undefined', true, k);
    }
    assert.match(onepiece.api, /optcgapi\.com/);
    assert.match(onepiece.theme.imgHosts, /optcgapi\.com/);
    assert.equal(onepiece.hasApiKey, undefined);
    assert.equal(onepiece.configure, undefined);
    assert.equal(onepiece.persistCard, undefined);
    assert.equal(onepiece.withArt, undefined);
  });

  it('package.json has no One Piece API key setting', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    assert.equal(manifest.contributes.configuration.properties['ygoDuel.onePiece.apiKey'], undefined);
    const cmds = manifest.contributes.commands.map(c => c.command).join(' ');
    assert.match(cmds, /openRiftbound/);
    assert.match(cmds, /openOnePiece/);
  });

  it('keeps Leaders and Characters; drops Events / DON!!', () => {
    assert.equal(onepiece.keep({ card_name: 'Zoro', card_type: 'Leader', card_image_id: 'OP01-001' }), true);
    assert.equal(onepiece.keep({ card_name: 'Nami', card_type: 'Character', card_image_id: 'OP01-016' }), true);
    assert.equal(onepiece.keep({ card_name: 'Diable Jambe', card_type: 'Event', card_image_id: 'ST01-016' }), false);
    assert.equal(onepiece.keep({ card_name: 'DON!!', card_type: 'DON!!', card_image_id: 'DON' }), false);
  });

  it('prefers market_price and falls back to inventory_price', () => {
    assert.equal(onepiece._priceFromCard({ market_price: 0.57, inventory_price: 0.56 }), 0.57);
    assert.equal(onepiece._priceFromCard({ market_price: 0, inventory_price: 2.05 }), 2.05);
    assert.equal(onepiece._priceFromCard({ market_price: null, inventory_price: null }), null);
  });

  it('normalize maps rarity, public image URL, and Parallel-unique ids', () => {
    const raw = {
      inventory_price: 169.0,
      market_price: 568.01,
      card_name: 'Roronoa Zoro (001) (Parallel)',
      set_name: 'Romance Dawn',
      set_id: 'OP-01',
      rarity: 'L',
      card_set_id: 'OP01-001',
      card_color: 'Red',
      card_type: 'Leader',
      card_cost: null,
      card_power: '5000',
      card_image_id: 'OP01-001_p1',
      card_image: 'https://optcgapi.com/media/static/Card_Images/OP01-001_p1.jpg'
    };
    const card = onepiece.normalize(raw);
    assert.equal(card.id, 'OP01-001_p1');
    assert.equal(card.name, 'Roronoa Zoro (001) (Parallel)');
    assert.equal(card.rarity, 'Leader');
    assert.equal(card.power, 5000);
    assert.equal(card.attr, 'Red');
    assert.equal(card.price, 568.01);
    assert.equal(card.image, 'https://optcgapi.com/media/static/Card_Images/OP01-001_p1.jpg');
    assert.equal(onepiece.power(card), 5000);
  });
});

describe('extension wires both new games', () => {
  it('registers riftbound and onepiece without PokeWallet helpers', () => {
    const host = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');
    assert.match(host, /riftbound: require\('\.\/games\/riftbound'\)/);
    assert.match(host, /onepiece: require\('\.\/games\/onepiece'\)/);
    assert.match(host, /ygoDuel\.openRiftbound/);
    assert.match(host, /ygoDuel\.openOnePiece/);
    assert.doesNotMatch(host, /PokeWallet|onePiece\.apiKey|persistCard|withArt|assertGameReady/);
  });

  it('does not hardcode an email; Riftbound UA is neutral and http default is unchanged', () => {
    const httpSrc = fs.readFileSync(path.join(__dirname, 'http.js'), 'utf8');
    const riftSrc = fs.readFileSync(path.join(__dirname, 'games/riftbound.js'), 'utf8');
    const pokeSrc = fs.readFileSync(path.join(__dirname, 'games/pokemon.js'), 'utf8');
    const ygoSrc = fs.readFileSync(path.join(__dirname, 'games/yugioh.js'), 'utf8');
    assert.match(httpSrc, /DEFAULT_UA = 'ygo-duel-vscode-extension'/);
    assert.match(riftSrc, /tcg-pulls-vscode\/0\.1 \(\+https:\/\/github\.com\/kitsiosvas\/tcg-pulls\)/);
    assert.doesNotMatch(httpSrc + riftSrc + pokeSrc + ygoSrc, /@gmail\.com|kitsios\.va@/);
    // No frankfurter fire-and-forget at module load in the game adapters.
    assert.doesNotMatch(riftSrc, /getJson\('https:\/\/api\.frankfurter/);
    assert.doesNotMatch(pokeSrc, /getJson\('https:\/\/api\.frankfurter/);
    assert.doesNotMatch(ygoSrc, /getJson\('https:\/\/api\.frankfurter/);
    assert.match(riftSrc, /require\('\.\.\/fx'\)/);
    assert.match(pokeSrc, /require\('\.\.\/fx'\)/);
    assert.match(ygoSrc, /require\('\.\.\/fx'\)/);
  });
});
