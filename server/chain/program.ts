// The StakeClash on-chain program (programs/stakeclash) from the server's side: its address,
// account addresses (PDAs), instruction builders and the event decoder. Borsh layouts are written
// as schemas so encoding and decoding share one definition and mirror the Rust structs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AccountRole, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction } from "@solana/kit";
import { ABILITY_KEYS, ORDER_KEYS, UNIT_KEYS } from "../../shared/rules.js";

/** The program address: STAKECLASH_PROGRAM_ID, else the contract's own declare_id! (one place to change). */
function declaredId(): string {
  try {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "programs", "stakeclash", "src", "lib.rs"), "utf8");
    const m = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(src);
    if (m) return m[1];
  } catch {
    /* source not shipped with this build */
  }
  return "3bXC59d9UQihNDpY17QFbQTf9WavttgpdtfGfMRuGLAs";
}
export const PROGRAM_ID = (process.env.STAKECLASH_PROGRAM_ID ?? declaredId()) as Address;
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
export const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111" as Address;
export const SLOT_HASHES = "SysvarS1otHashes111111111111111111111111111" as Address;
export const NO_ABILITY = 255;

// ── Borsh, by schema ──────────────────────────────────────────────────
type T = "u8" | "u16" | "u32" | "i32" | "u64" | "i64" | "bool" | "pubkey" | "string" | { array: [T, number] } | { option: T } | { struct: Schema };
type Schema = [string, T][];

const SLOT: Schema = [["unit", "u8"], ["n", "u16"]];
const CHAMPION: Schema = [["hp", "u32"], ["atk", "u32"], ["splash", "bool"]];
export const BATTLE_SIDE: Schema = [
  ["slots", { array: [{ struct: SLOT }, 9] }],
  ["order", "u8"],
  ["abilities", { array: ["u8", 2] }],
  ["levels", { array: ["u8", 6] }],
  ["boosts", { array: ["i32", 7] }],
  ["vigor", { array: ["i32", 7] }],
  ["towers", "u8"],
  ["champion", { option: { struct: CHAMPION } }],
];

const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();

export function encode(schema: Schema, value: any): Buffer {
  const parts: Buffer[] = [];
  const put = (t: T, v: any) => {
    if (t === "u8") parts.push(Buffer.from([v & 0xff]));
    else if (t === "bool") parts.push(Buffer.from([v ? 1 : 0]));
    else if (t === "u16") { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); }
    else if (t === "u32") { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); }
    else if (t === "i32") { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); }
    else if (t === "u64") { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); }
    else if (t === "i64") { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); parts.push(b); }
    else if (t === "pubkey") parts.push(Buffer.from(addrEnc.encode(v as Address)));
    else if (t === "string") { const s = Buffer.from(String(v), "utf8"); const b = Buffer.alloc(4); b.writeUInt32LE(s.length); parts.push(b, s); }
    else if ("array" in t) { const [et, n] = t.array; if (!Array.isArray(v) || v.length !== n) throw new Error(`expected ${n} items`); for (const x of v) put(et, x); }
    else if ("option" in t) { if (v == null) parts.push(Buffer.from([0])); else { parts.push(Buffer.from([1])); put(t.option, v); } }
    else for (const [k, st] of t.struct) put(st, v[k]);
  };
  for (const [k, t] of schema) put(t, value[k]);
  return Buffer.concat(parts);
}

export function decode(schema: Schema, buf: Uint8Array, at = 0): { value: any; end: number } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = at;
  const get = (t: T): any => {
    if (t === "u8") return b.readUInt8(o++);
    if (t === "bool") return b.readUInt8(o++) !== 0;
    if (t === "u16") return (o += 2), b.readUInt16LE(o - 2);
    if (t === "u32") return (o += 4), b.readUInt32LE(o - 4);
    if (t === "i32") return (o += 4), b.readInt32LE(o - 4);
    if (t === "u64") return (o += 8), Number(b.readBigUInt64LE(o - 8));
    if (t === "i64") return (o += 8), Number(b.readBigInt64LE(o - 8));
    if (t === "pubkey") return (o += 32), addrDec.decode(b.subarray(o - 32, o));
    if (t === "string") { const n = b.readUInt32LE(o); o += 4 + n; return b.toString("utf8", o - n, o); }
    if ("array" in t) return Array.from({ length: t.array[1] }, () => get(t.array[0]));
    if ("option" in t) return b.readUInt8(o++) ? get(t.option) : null;
    const v: any = {};
    for (const [k, st] of t.struct) v[k] = get(st);
    return v;
  };
  const value: any = {};
  for (const [k, t] of schema) value[k] = get(t);
  return { value, end: o };
}

const disc = (kind: "global" | "event", name: string) => crypto.createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);

// ── Events ────────────────────────────────────────────────────────────
export const EVENTS: Record<string, Schema> = {
  PlayerRegistered: [["v", "u8"], ["wallet", "pubkey"], ["profile", "pubkey"], ["at", "i64"]],
  GoldSettled: [["v", "u8"], ["wallet", "pubkey"], ["delta", "i64"], ["balance", "u64"], ["reason", "string"]],
  MightMinted: [["v", "u8"], ["wallet", "pubkey"], ["amount", "u64"], ["reason", "u8"]],
  MightBurned: [["v", "u8"], ["wallet", "pubkey"], ["amount", "u64"], ["reason", "u8"]],
  UnitUpgraded: [["v", "u8"], ["wallet", "pubkey"], ["unit", "u8"], ["level", "u8"], ["drills", "u8"], ["gold_spent", "u64"]],
  AbilityUnlocked: [["v", "u8"], ["wallet", "pubkey"], ["ability", "u8"], ["might_spent", "u64"]],
  LoadoutSet: [["v", "u8"], ["wallet", "pubkey"], ["loadout", { array: ["u8", 2] }]],
  FormationSet: [["v", "u8"], ["wallet", "pubkey"], ["formation", { array: [{ struct: SLOT }, 9] }], ["order", "u8"]],
  Escrowed: [["v", "u8"], ["stake", "u64"], ["wallet", "pubkey"], ["mint", "pubkey"], ["amount", "u64"], ["memo", "string"]],
  Released: [["v", "u8"], ["stake", "u64"], ["amount", "u64"], ["burned", "u64"]],
  RewardPaid: [["v", "u8"], ["wallet", "pubkey"], ["mint", "pubkey"], ["amount", "u64"], ["memo", "string"]],
  YieldConverted: [["v", "u8"], ["wallet", "pubkey"], ["usdc", "u64"], ["might", "u64"], ["realized_total", "u64"]],
  BattleResolved: [
    ["v", "u8"], ["seq", "u64"], ["kind", "u8"], ["context", "string"], ["attacker", "pubkey"], ["defender", "pubkey"], ["seed", "u32"],
    ["attacker_side", { struct: BATTLE_SIDE }], ["defender_side", { struct: BATTLE_SIDE }],
    ["attacker_won", "bool"], ["ticks", "u32"], ["destruction_pm", "u32"], ["survival_pm", "u32"], ["score", "u32"], ["lost", { array: ["u32", 6] }],
  ],
};
const EVENT_BY_DISC = new Map(Object.keys(EVENTS).map((n) => [disc("event", n).toString("hex"), n]));
export type ProgramEvent = { name: string; data: any };

/** Encode an event exactly as `emit!` does (discriminator + borsh), for tests and local mode. */
export const encodeEvent = (name: string, data: any) => Buffer.concat([disc("event", name), encode(EVENTS[name], data)]);

/** Decode one "Program data: <base64>" payload, or null if it isn't one of ours. */
export function decodeEvent(b64: string): ProgramEvent | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (raw.length < 8) return null;
  const name = EVENT_BY_DISC.get(raw.subarray(0, 8).toString("hex"));
  if (!name) return null;
  try {
    return { name, data: decode(EVENTS[name], raw, 8).value };
  } catch {
    return null;
  }
}

/**
 * Events from a transaction's log messages. Only "Program data:" lines emitted while our program
 * is the one executing count (a CPI'd program could print look-alike lines).
 */
export function eventsFromLogs(logs: string[], programId: string = PROGRAM_ID): ProgramEvent[] {
  const out: ProgramEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); continue; }
    if (/^Program (\w+) (success|failed)/.test(line)) { stack.pop(); continue; }
    if (line.startsWith("Program data: ") && stack[stack.length - 1] === programId) {
      const e = decodeEvent(line.slice("Program data: ".length));
      if (e) out.push(e);
    }
  }
  return out;
}

// ── Accounts ──────────────────────────────────────────────────────────
const pda = async (...seeds: (string | Uint8Array)[]) => (await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)) }))[0];
export const configPda = () => pda("config");
export const profilePda = (wallet: Address) => pda("player", addrEnc.encode(wallet) as Uint8Array);
export const goldPda = (wallet: Address) => pda("gold", addrEnc.encode(wallet) as Uint8Array);
export const mightPda = (wallet: Address) => pda("might", addrEnc.encode(wallet) as Uint8Array);
export const vaultPda = (mint: Address) => pda("vault", addrEnc.encode(mint) as Uint8Array);
export const stakePda = (id: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(id)); return pda("stake", b); };

/**
 * A player's on-chain identity. Players without a wallet still get a stable key: 32 bytes derived
 * from their game id. It is only a PDA seed and an identity; the game authority signs for them.
 */
export function playerKey(playerId: string): Address {
  return addrDec.decode(crypto.createHash("sha256").update(`stakeclash:player:${playerId}`).digest());
}

// ── Instructions ──────────────────────────────────────────────────────
type Meta = [Address, "w" | "r" | "ws" | "rs"];
const ROLE = { r: AccountRole.READONLY, w: AccountRole.WRITABLE, rs: AccountRole.READONLY_SIGNER, ws: AccountRole.WRITABLE_SIGNER };
function ix(name: string, args: Schema, values: any, metas: Meta[]): Instruction {
  return { programAddress: PROGRAM_ID, accounts: metas.map(([address, r]) => ({ address, role: ROLE[r] })), data: Buffer.concat([disc("global", name), encode(args, values)]) };
}

export type Mints = { gold: Address; might: Address };

/** One-time setup after deploy: the config PDA and the Gold and Might mints (fresh keypairs, signers). */
export async function initializeIx(authority: Address, goldMint: Address, mightMint: Address) {
  return ix("initialize", [], {}, [[authority, "ws"], [await configPda(), "w"], [goldMint, "ws"], [mightMint, "ws"], [TOKEN_PROGRAM, "r"], [SYSTEM_PROGRAM, "r"], [RENT_SYSVAR, "r"]]);
}

/** Hand the game authority to another key (whoever runs the game server). Signed by the current authority. */
export async function setAuthorityIx(authority: Address, newAuthority: Address) {
  return ix("set_authority", [["new_authority", "pubkey"]], { new_authority: newAuthority }, [[authority, "rs"], [await configPda(), "w"]]);
}

export async function registerPlayerIx(authority: Address, mints: Mints, wallet: Address) {
  return ix("register_player", [["wallet", "pubkey"]], { wallet }, [
    [authority, "ws"], [await configPda(), "w"], [await profilePda(wallet), "w"], [mints.gold, "r"], [mints.might, "r"],
    [await goldPda(wallet), "w"], [await mightPda(wallet), "w"], [TOKEN_PROGRAM, "r"], [SYSTEM_PROGRAM, "r"], [RENT_SYSVAR, "r"],
  ]);
}

async function playerTokens(authority: Address, mints: Mints, wallet: Address): Promise<Meta[]> {
  return [[authority, "rs"], [await configPda(), "r"], [await profilePda(wallet), "w"], [mints.gold, "w"], [mints.might, "w"], [await goldPda(wallet), "w"], [await mightPda(wallet), "w"], [TOKEN_PROGRAM, "r"]];
}
export const settleGoldIx = async (a: Address, m: Mints, w: Address, delta: number, reason: string) => ix("settle_gold", [["delta", "i64"], ["reason", "string"]], { delta, reason: reason.slice(0, 48) }, await playerTokens(a, m, w));
export const convertYieldIx = async (a: Address, m: Mints, w: Address, usdc: number, might: number) => ix("convert_yield", [["usdc", "u64"], ["might", "u64"]], { usdc, might }, await playerTokens(a, m, w));
export const mintMightIx = async (a: Address, m: Mints, w: Address, amount: number, reason: number) => ix("mint_might", [["amount", "u64"], ["reason", "u8"]], { amount, reason }, await playerTokens(a, m, w));
export const burnMightIx = async (a: Address, m: Mints, w: Address, amount: number, reason: number) => ix("burn_might", [["amount", "u64"], ["reason", "u8"]], { amount, reason }, await playerTokens(a, m, w));
export const upgradeUnitIx = async (a: Address, m: Mints, w: Address, unit: number, goldCost: number) => ix("upgrade_unit", [["unit", "u8"], ["gold_cost", "u64"]], { unit, gold_cost: goldCost }, await playerTokens(a, m, w));
export const unlockAbilityIx = async (a: Address, m: Mints, w: Address, ability: number) => ix("unlock_ability", [["ability", "u8"]], { ability }, await playerTokens(a, m, w));
export const assignDrillsIx = async (a: Address, w: Address, unit: number, points: number) => ix("assign_drills", [["unit", "u8"], ["points", "u8"]], { unit, points }, [[a, "rs"], [await configPda(), "r"], [await profilePda(w), "w"]]);
export const setLoadoutIx = async (signer: Address, w: Address, loadout: number[]) => ix("set_loadout", [["loadout", { array: ["u8", 2] }]], { loadout }, [[signer, "rs"], [await configPda(), "r"], [await profilePda(w), "w"]]);
export const setFormationIx = async (signer: Address, w: Address, formation: { unit: number; n: number }[], order: number) =>
  ix("set_formation", [["formation", { array: [{ struct: SLOT }, 9] }], ["order", "u8"]], { formation, order }, [[signer, "rs"], [await configPda(), "r"], [await profilePda(w), "w"]]);

export async function escrowStakeIx(a: Address, mint: Address, isGold: boolean, w: Address, id: number, amount: number, memo: string) {
  return ix("escrow_stake", [["id", "u64"], ["amount", "u64"], ["memo", "string"]], { id, amount, memo: memo.slice(0, 32) }, [
    [a, "ws"], [await configPda(), "r"], [await profilePda(w), "r"], [mint, "r"], [isGold ? await goldPda(w) : await mightPda(w), "w"],
    [await vaultPda(mint), "w"], [await stakePda(id), "w"], [TOKEN_PROGRAM, "r"], [SYSTEM_PROGRAM, "r"], [RENT_SYSVAR, "r"],
  ]);
}
export async function releaseStakeIx(a: Address, mint: Address, isGold: boolean, id: number, to: Address, pay: number, burn: number, memo: string) {
  return ix("release_stake", [["pay", "u64"], ["burn", "u64"], ["memo", "string"]], { pay, burn, memo: memo.slice(0, 32) }, [
    [a, "rs"], [await configPda(), "r"], [await stakePda(id), "w"], [mint, "w"], [await vaultPda(mint), "w"],
    [await profilePda(to), "r"], [isGold ? await goldPda(to) : await mightPda(to), "w"], [TOKEN_PROGRAM, "r"],
  ]);
}
export async function resolveBattleIx(a: Address, kind: number, context: string, attacker: any, defender: any, atkWallet: Address | null, defWallet: Address | null) {
  // Anchor optional accounts: a missing one is passed as the program id
  return ix("resolve_battle", [["kind", "u8"], ["context", "string"], ["attacker", { struct: BATTLE_SIDE }], ["defender", { struct: BATTLE_SIDE }]], { kind, context: context.slice(0, 40), attacker, defender }, [
    [a, "rs"], [await configPda(), "w"], [SLOT_HASHES, "r"],
    [atkWallet ? await profilePda(atkWallet) : PROGRAM_ID, atkWallet ? "w" : "r"],
    [defWallet ? await profilePda(defWallet) : PROGRAM_ID, defWallet ? "w" : "r"],
  ]);
}

// ── Game values → program values ──────────────────────────────────────
export const unitIndex = (k: string) => UNIT_KEYS.indexOf(k);
export const abilityIndex = (k: string) => ABILITY_KEYS.indexOf(k);
export const orderIndex = (k: string) => Math.max(0, ORDER_KEYS.indexOf(k));
export const BATTLE_KIND: Record<string, number> = { bounty: 0, boss: 1, duel: 2, other: 3 };

/** A battle side from a game BattleRecord side (engine 2), in the program's BattleSide layout. */
export function battleSide(side: any): any {
  const f = side.formation ?? { slots: Array(9).fill(null), order: "hold" };
  const bps = (m: Record<string, number> | undefined) => [...UNIT_KEYS.map((k) => Math.round((m?.[k] ?? 0) * 10000)), Math.round((m?.all ?? 0) * 10000)];
  const ab = [...(f.abilities ?? [])].map(abilityIndex).filter((i) => i >= 0);
  const c = side.champions?.[0];
  return {
    slots: f.slots.map((s: any) => (s ? { unit: unitIndex(s.unit), n: s.n } : { unit: 0, n: 0 })),
    order: orderIndex(f.order),
    abilities: [ab[0] ?? NO_ABILITY, ab[1] ?? NO_ABILITY],
    levels: UNIT_KEYS.map((k) => Math.max(1, Math.min(5, side.levels?.[k] ?? 1))),
    boosts: bps(side.boosts),
    vigor: bps(side.vigor),
    towers: Math.max(0, Math.min(255, side.towers ?? 0)),
    champion: c ? { hp: c.hp, atk: Math.floor((c.dmg * 60) / Math.max(1, c.cooldown)), splash: c.splash > 0 } : null,
  };
}
