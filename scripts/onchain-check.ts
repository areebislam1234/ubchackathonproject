// Offline checks for the on-chain layer (no server, no cluster): the program's event and instruction
// encoding, log parsing, the Streams filter's program handling, and battle-side mapping.
//   npx tsx scripts/onchain-check.ts
import { buildFilter, runFilter } from "../server/chain/filter";
import * as P from "../server/chain/program";

let fails = 0;
const ok = (c: unknown, m: string) => (console.log(`${c ? "  PASS" : "  FAIL"} ${m}`), c || fails++);

const wallet = P.playerKey("player-1");
ok(wallet === P.playerKey("player-1") && wallet !== P.playerKey("player-2"), "every player has a stable on-chain key");

const side = P.battleSide({ formation: { slots: [{ unit: "tank", n: 2 }, null, null, null, null, null, { unit: "archer", n: 5 }, null, null], order: "focus", abilities: ["volley", "revive"] }, levels: { tank: 3 }, boosts: { archer: 0.05, all: 0.01 }, towers: 1, champions: [{ hp: 9000, dmg: 50, cooldown: 15, splash: 1 }] });
ok(side.slots[0].unit === 2 && side.slots[6].n === 5 && side.order === 2 && side.abilities.join() === "4,8" && side.boosts[1] === 500 && side.boosts[6] === 100 && side.champion.atk === 200, "game battle sides map to the program's BattleSide layout");

for (const [name, data] of Object.entries({
  AbilityUnlocked: { v: 1, wallet, ability: 4, might_spent: 600 },
  GoldSettled: { v: 1, wallet, delta: -125, balance: 875, reason: "net" },
  Escrowed: { v: 1, stake: 9, wallet, mint: wallet, amount: 200, memo: "duel:D-1" },
  BattleResolved: { v: 1, seq: 7, kind: 1, context: "boss:x", attacker: wallet, defender: wallet, seed: 99, attacker_side: side, defender_side: side, attacker_won: true, ticks: 5, destruction_pm: 1000, survival_pm: 800, score: 1460, lost: [0, 1, 0, 0, 0, 0] },
})) {
  const back = P.decodeEvent(P.encodeEvent(name, data).toString("base64"));
  ok(back?.name === name && JSON.stringify(back.data) === JSON.stringify(data), `${name} round-trips through borsh`);
}

const b64 = P.encodeEvent("MightMinted", { v: 1, wallet, amount: 5, reason: 0 }).toString("base64");
const logs = [`Program ${P.PROGRAM_ID} invoke [1]`, `Program data: ${b64}`, "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]", `Program data: ${b64}`, "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success", `Program ${P.PROGRAM_ID} success`];
ok(P.eventsFromLogs(logs).length === 1, "only events our program emitted are read from the logs (not look-alikes from a CPI)");

const filter = buildFilter("Auth1111111111111111111111111111111111111111", [], { depositMint: "", networkEvery: 0 });
const tx = (sig: string, err: unknown) => ({ transaction: { signatures: [sig], message: { accountKeys: [P.PROGRAM_ID] } }, meta: { err, logMessages: logs, preTokenBalances: [], postTokenBalances: [] } });
const out = runFilter(filter, { data: [{ slot: 1, blockTime: 1, transactions: [tx("ok", null), tx("bad", { InstructionError: [0, "Custom"] })] }] });
ok(out?.events?.length === 1 && out.events[0].signature === "ok" && out.events[0].programLogs.length >= 3, "the Streams filter forwards program logs and drops failed transactions");

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exitCode = fails ? 1 : 0;
