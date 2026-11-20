// Warlord dossiers: relic intelligence about a rival, built by the indexer from their battle history
// (on-chain once the program is live). The only way to read one is to spend a Spyglass of the Watch.
import { INFO_RELIC } from "../shared/rules.js";
import { db, type Player } from "./db";
import { dossier } from "./chain/indexer";
import { GameError, inventory } from "./players";

/** Find a rival by id or by name. */
function findRival(target: string) {
  const byId = db.data.players[target];
  if (byId) return byId;
  const id = db.data.usernames[String(target).trim().toLowerCase()];
  if (id) return db.data.players[id];
  return Object.values(db.data.players).find((p) => p.name.toLowerCase() === String(target).trim().toLowerCase()) ?? null;
}

/** Spend a Spyglass to read a rival's dossier. The snapshot is kept in the player's collection. */
export function readDossier(p: Player, target: string) {
  const rival = findRival(target);
  if (!rival) throw new GameError("No warlord by that name.", 404);
  if (rival.id === p.id) throw new GameError("Point the Spyglass at a rival, not at yourself.");
  const inv = inventory(p);
  if (!(inv.spyglasses! > 0)) throw new GameError(`You need a ${INFO_RELIC.name}. Rare and stronger bosses drop them.`);
  const data = dossier(rival);
  if (!data.battles) throw new GameError(`${rival.name} hasn't fought enough battles to read anything yet. Your Spyglass is safe.`);
  inv.spyglasses!--;
  p.dossiers ??= [];
  const entry = { target: rival.id, name: rival.name, at: Date.now(), data };
  p.dossiers.unshift(entry);
  p.dossiers.splice(20);
  db.save();
  return { dossier: entry, spyglasses: inv.spyglasses };
}

export const dossierList = (p: Player) => ({ spyglasses: inventory(p).spyglasses ?? 0, dossiers: p.dossiers ?? [], relic: INFO_RELIC });
