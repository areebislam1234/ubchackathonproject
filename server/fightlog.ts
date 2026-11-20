// The battle board: every fight as it happens (who beat whom, and the Solana block that decided it
// when the on-chain program ran the battle), plus standings built from those results.
import { BOSSES } from "../shared/rules.js";
import { db, type BattleRecord } from "./db";

function where(r: BattleRecord) {
  if (r.boss) return { kind: "boss", label: (BOSSES as any)[r.boss.replace(/^lair:/, "")]?.name ?? "Boss lair" };
  if (r.bounty?.startsWith("duel:")) return { kind: "duel", label: `Colosseum ${r.bounty.slice(5)}` };
  if (r.bounty?.startsWith("lair:")) return { kind: "boss", label: "Boss lair" };
  return { kind: "bounty", label: `Bounty ${r.bounty}` };
}

export function fightLog(limit = 40) {
  const all = Object.values(db.data.battles).sort((a, b) => b.at - a.at);
  const fights = all.slice(0, limit).map((r) => {
    const atkWon = r.result.winner === "attacker";
    const w = where(r);
    const c: any = r.chain;
    return {
      id: r.id,
      at: r.at,
      kind: w.kind,
      where: w.label,
      winner: { id: atkWon ? r.attacker.id : r.defender.id, name: atkWon ? r.attacker.name : r.defender.name },
      loser: { id: atkWon ? r.defender.id : r.attacker.id, name: atkWon ? r.defender.name : r.attacker.name },
      attacker: r.attacker.name,
      score: r.result.score,
      onchain: c?.mode === "chain",
      slot: c?.mode === "chain" ? c.slot : null,
      signature: c?.mode === "chain" ? c.signature : null,
      url: c?.mode === "chain" ? c.url : null,
    };
  });
  // standings: warlords only (guardians and bosses are opponents, not ranked)
  const rows = new Map<string, { id: string; name: string; bot: boolean; wins: number; losses: number; last: number }>();
  const add = (id: string, name: string, won: boolean, at: number) => {
    const p = db.data.players[id];
    if (!p) return; // guardians, bosses
    const row = rows.get(id) ?? { id, name: p.name ?? name, bot: !!p.bot, wins: 0, losses: 0, last: 0 };
    won ? row.wins++ : row.losses++;
    row.last = Math.max(row.last, at);
    rows.set(id, row);
  };
  for (const r of all) {
    const atkWon = r.result.winner === "attacker";
    add(r.attacker.id, r.attacker.name, atkWon, r.at);
    add(r.defender.id, r.defender.name, !atkWon, r.at);
  }
  const standings = [...rows.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.last - a.last).slice(0, 25);
  return { fights, standings, total: all.length, now: Date.now() };
}
