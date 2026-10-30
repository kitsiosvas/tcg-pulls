/*
 * Decide whether a stored card still belongs to a given game, based on its
 * image URL host. Used by sanitizeCollections / buffer cache load to drop
 * cards that a past cross-game race filed under the wrong game.
 *
 * A card is foreign only when its image URL clearly matches another game's
 * imgHosts. An unknown / future CDN host is kept — otherwise a host move by
 * OpenRift or OPTCG would silently wipe the user's collection.
 */

function hostList(gameDef) {
  return String((gameDef && gameDef.theme && gameDef.theme.imgHosts) || '')
    .split(/\s+/)
    .filter(Boolean);
}

/** True if `card` may stay in `gameDef`'s collection.
 *  `games` is the full game-id → definition map (same shape as GAMES). */
function cardBelongsToGame(card, gameDef, games) {
  const url = card && card.image;
  if (!url) return true;
  const own = hostList(gameDef);
  if (own.some(h => url.startsWith(h))) return true;
  for (const other of Object.values(games || {})) {
    if (other === gameDef) continue;
    if (hostList(other).some(h => url.startsWith(h))) return false;
  }
  return true;
}

module.exports = { cardBelongsToGame, hostList };
