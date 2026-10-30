'use strict';
const { describe, it } = require('node:test');
const assert = require('assert/strict');

const fx = require('./fx');
const { cardBelongsToGame } = require('./card-belongs');
const riftbound = require('./games/riftbound');
const onepiece = require('./games/onepiece');
const yugioh = require('./games/yugioh');
const pokemon = require('./games/pokemon');

const GAMES_FIXTURE = { yugioh, pokemon, riftbound, onepiece };

describe('cardBelongsToGame', () => {
  it('keeps a card on its own game imgHosts', () => {
    const op = { name: 'Zoro', image: 'https://optcgapi.com/media/static/Card_Images/OP01-001.jpg' };
    assert.equal(cardBelongsToGame(op, onepiece, GAMES_FIXTURE), true);
    const ygo = { name: 'Dark Magician', image: 'https://images.ygoprodeck.com/images/cards/46986414.jpg' };
    assert.equal(cardBelongsToGame(ygo, yugioh, GAMES_FIXTURE), true);
  });

  it('drops a card whose image URL belongs to another game', () => {
    const ygoCard = { name: 'Dark Magician', image: 'https://images.ygoprodeck.com/images/cards/46986414.jpg' };
    assert.equal(cardBelongsToGame(ygoCard, pokemon, GAMES_FIXTURE), false);
    assert.equal(cardBelongsToGame(ygoCard, riftbound, GAMES_FIXTURE), false);
  });

  it('keeps a card whose image URL is an unknown / future CDN host', () => {
    const moved = {
      name: 'Adaptatron',
      image: 'https://cdn.example.com/riftbound/cards/adaptatron.webp'
    };
    assert.equal(cardBelongsToGame(moved, riftbound, GAMES_FIXTURE), true);
    assert.equal(cardBelongsToGame(moved, onepiece, GAMES_FIXTURE), true);
  });
});

describe('fx.getEurUsd', () => {
  it('falls back to 1.10 until the first fetch resolves', () => {
    fx._resetForTest();
    assert.equal(fx.eurUsd(), 1.10);
  });

  it('caches a positive rate after the first await', async () => {
    fx._resetForTest();
    const rate = await fx.getEurUsd();
    assert.ok(rate > 0, 'rate should be positive, got ' + rate);
    assert.equal(fx.eurUsd(), rate);
    assert.equal(await fx.getEurUsd(), rate);
  });
});

describe('riftbound adapter', () => {
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
