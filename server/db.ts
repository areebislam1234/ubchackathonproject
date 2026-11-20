// The game database: one JSON document per network, saved atomically a moment after each change.
// Small enough for a hackathon, and easy to inspect: .data/<network>/db.json.
import fs from "node:fs";
import path from "node:path";
import { networkDataDir } from "./config";
import type { IntelReport } from "./intel/types";

export type UnitMap = Record<string, number>;
export type WalletKind = "ingame" | "phantom" | "standard" | "address" | "demo";
export type BadgeState = { earnedAt: number; status: "unclaimed" | "minting" | "onchain" | "failed"; signature?: string; error?: string; owner?: string };

export type Player = {
  id: string;
  name: string;
  email?: string;
  createdAt: number;
  bot?: boolean;
  gold: number;
  crystals: number;
  trophies: number;
  buildings: Record<string, number>;
  army: UnitMap;
  unitLevels: UnitMap;
  pos: { x: number; y: number } | null;
  explored: string; // base64 bitmap of fog cells
  discovered: string[];
  attuned: string[];
  auth?: { algo: "scrypt"; salt: string; hash: string };
  home?: { x: number; y: number };
  lastCombatAt?: number;
  // ingame: key made and kept in the player's browser · phantom / standard: an installed wallet
  // (both proven by signing) · address: pasted, receive-only, unverified · demo: legacy server-held key
  wallet?: { address: string; kind: WalletKind; label?: string; verified?: boolean; linkedAt: number };
  demoSecret?: number[];
  badges: Record<string, BadgeState>;
  stats: { battles: number; wins: number; bountiesEntered: number; bountiesWon: number; predictions: number; correct: number; discovered: number; crystalsEarned: number };
  history: { bounty: string; rank: number; of: number; score: number; at: number }[];
  // Boss lairs. Optional so saves from before bosses existed load unchanged.
  bosses?: { discovered: string[]; cooldowns: Record<string, number>; kills: Record<string, number> };
  bossClaims?: Record<string, { at: number; response: unknown }>; // challenge requestId → result (idempotency)
  inventory?: Inventory;
  intel?: IntelReport[]; // collected intelligence reports, kept forever
  dossiers?: { target: string; name: string; at: number; data: unknown }[]; // Warlord dossiers read with a Spyglass
  drills?: Drills;
  // The yield economy (all money in integer micro-USDC). Optional: created on first use.
  funds?: Funds;
  might?: number; // upgrade currency, from converted realized yield
  mastery?: Record<string, number>; // legacy Mastery ranks, refunded into Might at load and cleared
  abilities?: { unlocked: string[]; loadout: string[] }; // class abilities bought with Might
  fundClaims?: Record<string, { at: number; response: unknown }>; // money requestId → result (idempotency)
  colosseum?: { duels: number; steelWins: number; foresightWins: number; mightWon: number; claims?: Record<string, { at: number; response: unknown }> };
  formation?: SavedFormation; // battle formation (also used to defend inside bounties)
};

export type FormationSlot = { unit: string; n: number } | null;
export type Formation = { slots: FormationSlot[]; order: string; preset?: string | null; abilities?: string[] };
/** manual: the player placed troops by hand; otherwise the preset is re-applied to the current army. */
export type SavedFormation = Formation & { manual: boolean };

export type LedgerEntry = {
  at: number;
  kind: "deposit" | "buy" | "sell" | "convert" | "withdraw" | "withdraw-refund" | "dev-credit";
  usdc: number; // micro-USDC moved (positive = into cash)
  coin?: string;
  qty?: number;
  price?: number; // USD per coin at the fill
  realized?: number; // micro-USDC realized by a sale
  might?: number;
  signature?: string;
  status?: "pending" | "sent" | "confirmed" | "failed";
  error?: string;
};

export type Funds = {
  cash: number; // uninvested USDC in the game
  principal: number; // net deposited: deposits minus withdrawals
  positions: Record<string, { qty: number; cost: number }>; // cost basis in micro-USDC
  realized: number; // lifetime realized profit and loss (can be negative)
  converted: number; // realized profit already converted into Might
  ledger: LedgerEntry[];
};

/** Minor army upgrades earned from bosses. */
export type Drills = {
  units: Record<string, number>; // points spent per unit type
  pool: number; // earned, not yet assigned
  day: string; // UTC day of `today`
  today: number; // points earned from bosses on that day
};

export type Inventory = {
  materials: Record<string, number>; // timber, stone, iron
  manuals: Record<string, number>; // per unit type: one free level each
  scrolls: number; // a free level for any unit
  relics: Record<string, { at: number; from: string }>;
  spyglasses?: number; // Information Relics: each reveals one rival's Warlord dossier
};

export type Entry = {
  playerId: string;
  name: string;
  bot: boolean;
  joinedAt: number;
  score: number;
  attacks: number;
  defense: number;
  best: number;
  army: UnitMap;
  levels: UnitMap;
  towers: number;
  boosts?: Record<string, number>; // damage bonuses (relics, drills), frozen at entry like the army
  vigor?: Record<string, number>; // HP bonuses (drills)
  formation?: Formation; // how this entrant defends, frozen at entry like the army
  botPlan?: number[]; // bots: times of their attacks
};

export type Prediction = {
  playerId: string;
  name: string;
  bot: boolean;
  side: "yes" | "no";
  confBps: number;
  stake: number;
  priceBps: number;
  at: number;
  payout?: number;
  crystals?: number;
  correct?: boolean;
  brier?: number;
};

export type Bounty = {
  id: string;
  seq: number;
  tier: "common" | "rare" | "epic";
  featured: boolean;
  realm: string;
  x: number;
  y: number;
  market: string;
  eventTicker: string;
  question: string;
  eventTitle: string;
  category: string;
  expiry: string | null;
  createdAt: number;
  startsAt: number;
  endsAt: number;
  status: "upcoming" | "active" | "revealed" | "resolved";
  entries: Record<string, Entry>;
  predictions: Record<string, Prediction>;
  results?: {
    ranking: { playerId: string; name: string; bot: boolean; score: number; rank: number; gold: number; stakeCap: number; trophies: number }[];
    finalizedAt: number;
    hash: string;
    seal?: { signature?: string; status: "sending" | "sent" | "onchain" | "failed"; error?: string };
  };
  quote?: { bidBps: number | null; askBps: number | null; at: number };
  revealQuote?: { bidBps: number | null; askBps: number | null };
  /** "void": the market never settled on Gemini, so stakes were refunded */
  outcome?: "yes" | "no" | "void";
  resolvedAt?: number;
  wildcard?: boolean; // Gemini had no market in this realm's category
  hot?: boolean; // spawned because its market moved sharply
};

export type Champion = { look: string; hp: number; dmg: number; range: number; speed: number; cooldown: number; splash: number };

export type BattleRecord = {
  id: string;
  engine?: number; // 2 = formations and rounds; missing = the original engine (old records)
  chain?: { mode: "chain" | "simulate"; seed: number; signature: string; slot: number | null; url: string | null; engineMismatch?: boolean }; // decided by the on-chain program
  bounty: string;
  at: number;
  seed: number;
  attacker: { id: string; name: string; units: UnitMap; levels: UnitMap; boosts?: Record<string, number>; vigor?: Record<string, number>; formation?: Formation };
  defender: { id: string; name: string; units: UnitMap; levels: UnitMap; towers: number; guardian?: boolean; champions?: Champion[]; boosts?: Record<string, number>; vigor?: Record<string, number>; formation?: Formation };
  boss?: string; // lair id, for boss fights (bounty is then "lair:<id>")
  result: { winner: string; ticks: number; destruction: number; survival: number; score: number; lost: UnitMap; report?: unknown; orders?: string[] };
};

export type FeedItem = { at: number; kind: string; text: string; bounty?: string; signature?: string; player?: string; market?: string; duel?: string };

/** An on-chain receipt: a memo the game posts, confirmed when the QuickNode Stream delivers it. */
export type Receipt = { memo: string; status: "sending" | "sent" | "onchain" | "failed"; signature?: string; error?: string; verified?: boolean };

/** One side of a Colosseum duel: the army sent and a call on the duel's Gemini market. */
export type DuelSide = {
  playerId: string;
  name: string;
  bot: boolean;
  wallet?: string;
  units: UnitMap;
  levels: UnitMap;
  boosts?: Record<string, number>;
  vigor?: Record<string, number>;
  formation?: Formation; // duels fight in formations (engine 2), with the side's abilities
  power: number;
  // the call, committed on Solana as a hash before anyone fights and revealed afterwards
  call: { side: "yes" | "no"; confBps: number; priceBps: number; at: number; salt: string; commit: string };
  receipt?: Receipt;
  brier?: number;
  payout?: number; // Might paid to this side (steel + foresight)
};

export type Duel = {
  id: string;
  createdAt: number;
  status: "open" | "fighting" | "fought" | "settled" | "cancelled";
  fightingSince?: number; // set while the chain decides the fight; a stale one is recovered
  stake: number; // Might each side put up
  market: string;
  question: string;
  eventTitle: string;
  category: string;
  expiry: string | null;
  practice: boolean; // mock Gemini market
  challenger: DuelSide;
  rival?: DuelSide;
  botAt?: number; // when a rival warlord steps in if no one has accepted
  battle?: string;
  steel?: { winner: string; pot: number; at: number };
  foresight?: { winner: string | "split"; pot: number; outcome: "yes" | "no"; at: number };
  burned?: number;
  hash?: string;
  seal?: Receipt;
  settledAt?: number;
};

/** One sampled block's activity, from the QuickNode Stream filter. */
export type NetworkSample = { slot: number; blockTime: number | null; txCount: number; failed: number; vote: number; programs: Record<string, number>; transfers: Record<string, { count: number; amount: number }>; receivedAt: number };

export type ChainEvent = { signature: string; slot: number; blockTime: number | null; memos: string[]; badges: { mint: string; owner: string; pre: number; post: number }[]; receivedAt: number };

export type DBShape = {
  players: Record<string, Player>;
  sessions: Record<string, string>;
  sessionSeen?: Record<string, number>; // token → last use, for idle expiry
  deposits?: {
    refs: Record<string, { player: string; at: number }>; // Solana Pay reference key → player
    unclaimed: { signature: string; from: string; usdc: number; at: number }[]; // deposits no player could be matched to
  };
  usernames: Record<string, string>; // lower-case name → player id
  emails?: Record<string, string>; // legacy
  bounties: Record<string, Bounty>;
  duels?: Record<string, Duel>;
  battles: Record<string, BattleRecord>;
  feed: FeedItem[];
  chain: { processed: Record<string, number>; holdings: Record<string, Record<string, number>>; events: ChainEvent[]; deliveries: number; network?: NetworkSample[] };
  meta: { bountySeq: number; battleSeq: number; playerSeq: number; duelSeq?: number };
};

const empty = (): DBShape => ({
  players: {},
  sessions: {},
  usernames: {},
  bounties: {},
  battles: {},
  feed: [],
  chain: { processed: {}, holdings: {}, events: [], deliveries: 0 },
  meta: { bountySeq: 400, battleSeq: 0, playerSeq: 0 },
});

class Database {
  file = path.join(networkDataDir, "db.json");
  data: DBShape;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    fs.mkdirSync(networkDataDir, { recursive: true });
    this.data = fs.existsSync(this.file) ? { ...empty(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) } : empty();
    // older saves: index usernames from existing players
    for (const p of Object.values(this.data.players)) {
      const key = p.name.trim().toLowerCase();
      if (!p.bot && !this.data.usernames[key]) this.data.usernames[key] = p.id;
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (err) {
        // Windows: OneDrive/antivirus can briefly lock db.json; don't crash, try again shortly
        console.warn(`db save failed (${(err as NodeJS.ErrnoException).code ?? err}), retrying`);
        this.save();
      }
    }, 400);
  }

  flush() {
    // trim history that grows forever
    const d = this.data;
    if (d.feed.length > 300) d.feed = d.feed.slice(-300);
    if (d.chain.events.length > 500) d.chain.events = d.chain.events.slice(-500);
    if ((d.chain.network?.length ?? 0) > 500) d.chain.network = d.chain.network!.slice(-500);
    const duels = Object.values(d.duels ?? {}).filter((x) => x.status === "settled" || x.status === "cancelled");
    if (duels.length > 1000) for (const x of duels.sort((a, c) => a.createdAt - c.createdAt).slice(0, duels.length - 1000)) delete d.duels![x.id];
    const battles = Object.values(d.battles);
    if (battles.length > 2000) for (const b of battles.sort((a, c) => a.at - c.at).slice(0, battles.length - 2000)) delete d.battles[b.id];
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(d));
    renameWithRetry(tmp, this.file);
  }
}

// On Windows, rename over a file another process has open (OneDrive sync, antivirus,
// the editor) fails with EPERM/EBUSY/EACCES for a short while. Retry briefly.
function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 10 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

export const db = new Database();

export function feed(item: Omit<FeedItem, "at">) {
  db.data.feed.push({ at: Date.now(), ...item });
  db.save();
}
