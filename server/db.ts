// The game database: one JSON document per network, saved atomically a moment after each change.
// Small enough for a hackathon, and easy to inspect: .data/<network>/db.json.
import fs from "node:fs";
import path from "node:path";
import { networkDataDir } from "./config";

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
  outcome?: "yes" | "no";
  resolvedAt?: number;
  wildcard?: boolean; // Gemini had no market in this realm's category
};

export type Champion = { look: string; hp: number; dmg: number; range: number; speed: number; cooldown: number; splash: number };

export type BattleRecord = {
  id: string;
  bounty: string;
  at: number;
  seed: number;
  attacker: { id: string; name: string; units: UnitMap; levels: UnitMap };
  defender: { id: string; name: string; units: UnitMap; levels: UnitMap; towers: number; guardian?: boolean; champions?: Champion[] };
  boss?: string; // lair id, for boss fights (bounty is then "lair:<id>")
  result: { winner: string; ticks: number; destruction: number; survival: number; score: number; lost: UnitMap };
};

export type FeedItem = { at: number; kind: string; text: string; bounty?: string; signature?: string; player?: string };

export type ChainEvent = { signature: string; slot: number; blockTime: number | null; memos: string[]; badges: { mint: string; owner: string; pre: number; post: number }[]; receivedAt: number };

export type DBShape = {
  players: Record<string, Player>;
  sessions: Record<string, string>;
  usernames: Record<string, string>; // lower-case name → player id
  emails?: Record<string, string>; // legacy
  bounties: Record<string, Bounty>;
  battles: Record<string, BattleRecord>;
  feed: FeedItem[];
  chain: { processed: Record<string, number>; holdings: Record<string, Record<string, number>>; events: ChainEvent[]; deliveries: number };
  meta: { bountySeq: number; battleSeq: number; playerSeq: number };
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
