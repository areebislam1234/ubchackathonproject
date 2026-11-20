// StakeClash game server: API, QuickNode Streams webhook, badge metadata and the static client.
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { BADGES, BADGE_IDS } from "../shared/rules.js";
import { PALETTE, SPRITES } from "../shared/sprites.js";
import { verifyStreamSignature } from "../shared/hmac";
import { IS_LOCAL, NETWORK, ROOT, env, explorerAddress, explorerTx, geminiBaseUrl } from "./config";
import { db, type Player } from "./db";
import { GameError, assignDrill, bySession, disband, logout, markExplored, onBadge, playerView, register, sendHome, setFormation, signIn, train, upgradeBuilding, upgradeUnit } from "./players";
import { assignHome, attack, battle, bountyFor, devEnd, devList, devSpawn, devStart, discover, enter, gemini, globalLeaderboard, mapFor, onSeal, opponents, predict, recall, spawnHot, tick, world } from "./bounties";
import { acceptChallenge, cancelChallenge, colosseumTick, colosseumView, devBotAccept, duelById, issueChallenge, onReceipt } from "./colosseum";
import { crierLog, crierTick, flushOdds, marketList, movers, oddsSeries, oddsTick, onHotMarket, sampleNow, windowMs } from "./odds";
import { clearCombat, grantBadge, resetProgress, revealAll, setPlayer } from "./dev";
import { challenge, devNextIntel, discoverLairs, lairView, lairsFor } from "./bosses";
import { intelList, reportView, resumeCompiling } from "./intel/reports";
import { buy, buyMastery, convert, devCredit, fundsView, newDepositReference, quotes, sell, setWithdrawSender, withdraw } from "./funds";
import { depositTarget, sendUsdc, solanaPayUrl, treasuryBalance } from "./chain/usdc";

setWithdrawSender(sendUsdc);
import { badgeMints, chainStatus, claimAll, holdingsFor, linkWallet, loadAuthority, mintBadge, postReceipt, sealResults, unlinkWallet, verifyWalletSignature, walletChallenge } from "./chain/solana";
import { applyEvents, applyNetwork, extractEvents, extractNetwork } from "./chain/stream";
import { encodePng } from "./png";

// When a badge is earned with a wallet linked, mint it; results get sealed on-chain.
onBadge((p, badge) => {
  if (p.wallet) void mintBadge(p, badge);
});
onSeal((b) => void sealResults(b));
onReceipt((r) => void postReceipt(r)); // Colosseum odds receipts and results, as Solana memos
onHotMarket((market, realm) => spawnHot(market, realm));
const marketsForOdds = () => gemini.openMarkets();

const app = express();
app.disable("x-powered-by");

// ── QuickNode Streams webhook (raw body for the HMAC) ─────────────────
app.post("/webhooks/quicknode", express.raw({ type: "*/*", limit: "25mb" }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (env.quicknodeWebhookSecret) {
    const ok = verifyStreamSignature(env.quicknodeWebhookSecret, raw, req.header("x-qn-nonce"), req.header("x-qn-timestamp"), req.header("x-qn-signature"));
    if (!ok) return void res.status(401).json({ error: "bad signature" });
  }
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return void res.status(400).json({ error: "invalid JSON" });
  }
  const events = extractEvents(body);
  const applied = applyEvents(events);
  const network = applyNetwork(extractNetwork(body)); // sampled blocks for crypto intel
  res.json({ ok: true, received: events.length, applied, network });
});

app.use(express.json({ limit: "1mb" }));

// ── Auth helpers ──────────────────────────────────────────────────────
type Authed = Request & { player: Player };
function auth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const p = bySession(token);
  if (!p) return void res.status(401).json({ error: "Sign in first." });
  (req as Authed).player = p;
  next();
}
const wrap =
  (fn: (req: Authed, res: Response) => unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req as Authed, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      const status = e instanceof GameError ? e.status : 400;
      res.status(status).json({ error: (e as Error).message });
    }
  };

// ── Account ───────────────────────────────────────────────────────────
app.post(
  "/api/register",
  wrap(async (req) => {
    const { token, player } = await register(req.body?.name, req.body?.password);
    assignHome(player);
    player.pos = { x: player.home!.x, y: player.home!.y + 2 };
    return { token, player: playerView(player) };
  }),
);
app.post(
  "/api/login",
  wrap(async (req) => {
    const r = await signIn(req.body?.name, req.body?.password);
    assignHome(r.player);
    sendHome(r.player);
    db.save();
    return { token: r.token, player: playerView(r.player), passwordSet: !!r.passwordSet };
  }),
);
app.post("/api/logout", (req, res) => {
  logout(req.header("authorization")?.replace(/^Bearer\s+/i, ""));
  res.json({ ok: true });
});
app.post("/api/recall", auth, wrap((req) => recall(req.player)));
app.get(
  "/api/me",
  auth,
  wrap((req) => {
    const p = req.player;
    const predictions = Object.values(db.data.bounties)
      .filter((b) => b.predictions[p.id])
      .sort((a, b) => b.predictions[p.id].at - a.predictions[p.id].at)
      .slice(0, 20)
      .map((b) => ({ bounty: b.id, question: b.question, status: b.status, ...b.predictions[p.id] }));
    return { ...playerView(p), onchain: holdingsFor(p.wallet?.address), predictions };
  }),
);
app.post(
  "/api/explore",
  auth,
  wrap((req) => {
    const p = req.player;
    const cells = Array.isArray(req.body?.cells) ? req.body.cells.slice(0, 4000) : [];
    markExplored(p, cells);
    const pos = req.body?.pos;
    if (pos && Number.isInteger(pos.x) && Number.isInteger(pos.y)) p.pos = { x: pos.x, y: pos.y };
    const found = discover(p, p.pos);
    const lairsFound = discoverLairs(p, p.pos);
    db.save();
    return { discovered: found, lairs: lairsFound };
  }),
);
app.post(
  "/api/attune",
  auth,
  wrap((req) => {
    const town = world.towns.find((t) => t.name === req.body?.town);
    if (!town) throw new GameError("No such waystone.");
    if (!req.player.attuned.includes(town.name)) req.player.attuned.push(town.name);
    db.save();
    return { attuned: req.player.attuned };
  }),
);

// ── Bounties ──────────────────────────────────────────────────────────
app.get("/api/bounties", auth, wrap((req) => ({ bounties: mapFor(req.player), now: Date.now() })));
app.get("/api/bounties/:id", auth, wrap((req) => bountyFor(req.player, String(req.params.id))));
app.post("/api/bounties/:id/enter", auth, wrap((req) => enter(req.player, String(req.params.id))));
app.get("/api/bounties/:id/opponents", auth, wrap((req) => ({ opponents: opponents(req.player, String(req.params.id)) })));
app.post("/api/bounties/:id/attack", auth, wrap((req) => attack(req.player, String(req.params.id), String(req.body?.opponent ?? "guardian"), req.body?.units ?? {}, { formation: req.body?.formation, preset: req.body?.preset, order: req.body?.order })));
app.post("/api/bounties/:id/predict", auth, wrap((req) => predict(req.player, String(req.params.id), req.body?.side, req.body?.confBps, req.body?.stake)));
app.get("/api/battles/:id", auth, wrap((req) => battle(String(req.params.id))));

// ── Odds over time, movers, the town crier (Gemini prices recorded by the server) ────────────────
app.get("/api/odds/movers", auth, wrap((req) => ({ window: windowMs(req.query.window), movers: movers(windowMs(req.query.window), 16), crier: crierLog(10), now: Date.now() })));
app.get("/api/odds/markets", auth, wrap(() => ({ markets: marketList(), now: Date.now() })));
app.get("/api/odds/:market", auth, wrap((req) => oddsSeries(String(req.params.market), windowMs(req.query.window))));

// ── The Colosseum ─────────────────────────────────────────────────────
app.get("/api/colosseum", auth, wrap((req) => colosseumView(req.player)));
app.get("/api/colosseum/:id", auth, wrap((req) => duelById(req.player, String(req.params.id))));
app.post("/api/colosseum/challenge", auth, wrap((req) => issueChallenge(req.player, req.body ?? {})));
app.post("/api/colosseum/:id/accept", auth, wrap((req) => acceptChallenge(req.player, String(req.params.id), req.body ?? {})));
app.post("/api/colosseum/:id/cancel", auth, wrap((req) => cancelChallenge(req.player, String(req.params.id))));

// ── Boss lairs ────────────────────────────────────────────────────────
app.get("/api/bosses", auth, wrap((req) => ({ lairs: lairsFor(req.player), now: Date.now() })));
app.get(
  "/api/bosses/:id",
  auth,
  wrap((req) => {
    const id = String(req.params.id);
    if (!req.player.bosses?.discovered.includes(id)) throw new GameError("You haven't found that lair yet.", 404);
    return lairView(req.player, id);
  }),
);

app.post(
  "/api/bosses/:id/challenge",
  auth,
  wrap((req) => {
    // the hero's position, reported the same way /api/explore reports it
    const pos = req.body?.pos;
    if (pos && Number.isInteger(pos.x) && Number.isInteger(pos.y)) req.player.pos = { x: pos.x, y: pos.y };
    return challenge(req.player, String(req.params.id), req.body?.units ?? {}, req.body?.requestId, { plan: { formation: req.body?.formation, preset: req.body?.preset, order: req.body?.order } });
  }),
);

// ── Intelligence reports ──────────────────────────────────────────────
app.get("/api/intel", auth, wrap((req) => ({ reports: intelList(req.player).map(reportView).reverse() })));
app.get(
  "/api/intel/:id",
  auth,
  wrap((req) => {
    const r = intelList(req.player).find((x) => x.id === String(req.params.id));
    if (!r) throw new GameError("No such report.", 404);
    return reportView(r);
  }),
);

// ── Treasury: deposits, investing, yield → Might ──────────────────────
app.get(
  "/api/funds",
  auth,
  wrap(async (req) => {
    const qs = await quotes();
    return { ...fundsView(req.player, qs), quotes: qs, testMoney: true, network: NETWORK };
  }),
);
app.get("/api/funds/quotes", auth, wrap(async () => ({ quotes: await quotes() })));
app.post("/api/funds/buy", auth, wrap((req) => buy(req.player, req.body?.coin, req.body?.usdc, req.body?.requestId)));
app.post("/api/funds/sell", auth, wrap((req) => sell(req.player, req.body?.coin, req.body?.qty, req.body?.requestId)));
app.post("/api/funds/convert", auth, wrap((req) => convert(req.player, req.body?.usdc, req.body?.requestId)));
app.post("/api/funds/withdraw", auth, wrap((req) => withdraw(req.player, req.body?.usdc, req.body?.requestId)));
app.post(
  "/api/funds/deposit",
  auth,
  wrap(async (req) => {
    const t = await depositTarget();
    if (!t) throw new GameError("Deposits aren't set up on this server yet (run npm run setup-solana).", 503);
    const reference = newDepositReference(req.player);
    const amount = Number(req.body?.usdc) > 0 ? Number(req.body.usdc) : null;
    return { recipient: t.owner, account: t.account, mint: t.mint, reference, url: solanaPayUrl(t.owner, t.mint, amount, reference), linkedWallet: req.player.wallet?.address ?? null };
  }),
);
app.post("/api/army/formation", auth, wrap((req) => (setFormation(req.player, req.body ?? {}), playerView(req.player))));
app.post("/api/army/mastery", auth, wrap((req) => (buyMastery(req.player, String(req.body?.unit)), playerView(req.player))));

// ── Fortress and army ─────────────────────────────────────────────────
app.post("/api/fortress/upgrade", auth, wrap((req) => upgradeBuilding(req.player, String(req.body?.building), { useMaterials: req.body?.useMaterials === true })));
app.post("/api/army/train", auth, wrap((req) => train(req.player, String(req.body?.unit), Number(req.body?.count ?? 1))));
app.post("/api/army/drill", auth, wrap((req) => (assignDrill(req.player, String(req.body?.unit), Number(req.body?.count ?? 1)), playerView(req.player))));
app.post("/api/army/disband", auth, wrap((req) => disband(req.player, String(req.body?.unit), Number(req.body?.count ?? 1))));
app.post("/api/army/upgrade", auth, wrap((req) => upgradeUnit(req.player, String(req.body?.unit), { use: req.body?.use === "manual" || req.body?.use === "scroll" ? req.body.use : undefined })));

// ── Wallet + badges ───────────────────────────────────────────────────
app.post("/api/wallet/challenge", auth, wrap((req) => ({ message: walletChallenge(req.player, String(req.body?.address ?? "")) })));
// Signed links: the wallet proves it's yours by signing a one-time message (no transaction, no fee).
app.post(
  "/api/wallet/link",
  auth,
  wrap(async (req) => {
    const address = String(req.body?.address ?? "");
    const kind = String(req.body?.kind ?? "phantom");
    if (!["ingame", "phantom", "standard"].includes(kind)) throw new GameError("Unknown wallet type.");
    verifyWalletSignature(req.player, address, String(req.body?.signature ?? ""));
    await linkWallet(req.player, address, kind as "ingame" | "phantom" | "standard", { label: String(req.body?.label ?? ""), verified: true });
    return playerView(req.player);
  }),
);
// Receive-only: any Solana address (a hardware or mobile wallet, an exchange…). We can't check it's yours.
app.post(
  "/api/wallet/address",
  auth,
  wrap(async (req) => {
    await linkWallet(req.player, String(req.body?.address ?? "").trim(), "address", { verified: false });
    return playerView(req.player);
  }),
);
app.post(
  "/api/wallet/unlink",
  auth,
  wrap((req) => {
    unlinkWallet(req.player);
    return playerView(req.player);
  }),
);
app.post(
  "/api/badges/claim",
  auth,
  wrap((req) => {
    if (!req.player.wallet) throw new GameError("Link a wallet first.");
    claimAll(req.player);
    return playerView(req.player);
  }),
);

// ── World-wide ────────────────────────────────────────────────────────
app.get("/api/leaderboard", wrap(() => ({ players: globalLeaderboard() })));
app.get(
  "/api/feed",
  wrap((req) => {
    const since = Number(req.query.since ?? 0);
    return { items: db.data.feed.filter((f) => f.at > since).slice(-30).map((f) => ({ ...f, explorer: f.signature ? explorerTx(f.signature) : null })) };
  }),
);
app.get(
  "/api/config",
  wrap(async () => {
    const auth = await loadAuthority({ create: false });
    return {
      network: NETWORK,
      gemini: env.geminiMode,
      devTools: env.devTools,
      mockGemini: env.geminiMode === "mock",
      explorerTx: IS_LOCAL ? null : "https://explorer.solana.com/tx/{sig}?cluster=devnet",
      authority: auth?.address ?? null,
      authorityExplorer: auth ? explorerAddress(auth.address) : null,
      mints: badgeMints(),
      badges: BADGES,
    };
  }),
);
app.get(
  "/api/health",
  wrap(async () => ({ ok: true, network: NETWORK, bounties: Object.keys(db.data.bounties).length, players: Object.keys(db.data.players).length, streamDeliveries: db.data.chain.deliveries, chainEvents: db.data.chain.events.length, chain: await chainStatus() })),
);
app.get("/api/chain/events", wrap(() => ({ events: db.data.chain.events.slice(-30).reverse().map((e) => ({ ...e, explorer: explorerTx(e.signature) })) })));

// ── Dev tools (mock Gemini only) ──────────────────────────────────────
const devOnly = (req: Request, res: Response, next: NextFunction) => (env.devTools ? next() : void res.status(404).json({ error: "Dev tools are off (DEV_TOOLS=off)." }));
app.post("/api/dev/player", devOnly, auth, wrap((req) => (setPlayer(req.player, req.body ?? {}), playerView(req.player))));
app.post("/api/dev/reveal", devOnly, auth, wrap((req) => (revealAll(req.player), playerView(req.player))));
app.post("/api/dev/clear-combat", devOnly, auth, wrap((req) => (clearCombat(req.player), playerView(req.player))));
app.post("/api/dev/badge", devOnly, auth, wrap((req) => (grantBadge(req.player, String(req.body?.badge)), playerView(req.player))));
app.post("/api/dev/reset", devOnly, auth, wrap((req) => (resetProgress(req.player), playerView(req.player))));
app.post(
  "/api/dev/next-intel",
  devOnly,
  auth,
  wrap((req) => {
    const r = String(req.body?.rarity ?? "");
    if (r && !["common", "rare", "epic", "legendary"].includes(r)) throw new GameError("Unknown rarity.");
    r ? devNextIntel.set(req.player.id, r) : devNextIntel.delete(req.player.id);
    return { next: r || null };
  }),
);
app.post(
  "/api/dev/usdc",
  devOnly,
  auth,
  wrap((req) => {
    const usdc = Math.max(0, Math.min(100000, Number(req.body?.usdc) || 0));
    if (usdc) devCredit(req.player, usdc);
    if (req.body?.might !== undefined) req.player.might = Math.max(0, Math.min(1e7, Math.floor(Number(req.body.might) || 0)));
    db.save();
    return fundsView(req.player);
  }),
);
app.get("/api/dev/deposits", devOnly, auth, wrap(async () => ({ unclaimed: db.data.deposits?.unclaimed ?? [], target: await depositTarget(), treasury: await treasuryBalance().catch(() => null) })));
app.post(
  "/api/dev/boss-cooldowns",
  devOnly,
  auth,
  wrap((req) => {
    if (req.player.bosses) req.player.bosses.cooldowns = {};
    db.save();
    return { ok: true };
  }),
);
app.get("/api/dev/bounties", devOnly, auth, wrap(() => ({ bounties: devList(), now: Date.now() })));
app.post("/api/dev/duel-bot", devOnly, auth, wrap((req) => ({ accepted: devBotAccept(req.player) })));
app.post(
  "/api/dev/duel-settle/:id",
  devOnly,
  auth,
  wrap(async (req) => {
    const d = db.data.duels?.[String(req.params.id)];
    if (!d) throw new GameError("No such duel.", 404);
    if (env.geminiMode !== "mock") throw new GameError("Settling by hand only works with mock Gemini.");
    const side = req.body?.side === "no" ? "no" : "yes";
    const r = await fetch(`${geminiBaseUrl}/mock/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market: d.market, side }) });
    if (!r.ok) throw new GameError("Mock Gemini refused to settle.");
    gemini.clearCache();
    await colosseumTick(true);
    return duelById(req.player, d.id);
  }),
);
app.post(
  "/api/dev/shock",
  devOnly,
  auth,
  wrap(async (req) => {
    // mock only: jolt a market's odds, then let the crier and the odds history see it right away
    if (env.geminiMode !== "mock") throw new GameError("Shocking a market only works with mock Gemini.");
    const r = await fetch(`${geminiBaseUrl}/mock/shock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market: req.body?.market ?? null, delta: Number(req.body?.delta ?? 0.15) }) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new GameError(j.error ?? "Mock Gemini refused.");
    gemini.clearCache();
    await sampleNow(marketsForOdds);
    const top = crierTick(Date.now(), { force: true });
    return { shocked: j.market, crier: top ? top.question : null };
  }),
);
app.post(
  "/api/dev/spawn",
  devOnly,
  auth,
  wrap(async (req) => {
    const b = await devSpawn(String(req.body?.realm), req.body?.tier || undefined, req.body?.active !== false, req.body?.featured);
    return { id: b.id, x: b.x, y: b.y };
  }),
);
app.post("/api/dev/end/:id", devOnly, auth, wrap((req) => (devEnd(String(req.params.id)), bountyFor(req.player, String(req.params.id)))));
app.post("/api/dev/start/:id", devOnly, auth, wrap((req) => (devStart(String(req.params.id)), bountyFor(req.player, String(req.params.id)))));
app.post(
  "/api/dev/settle/:id",
  devOnly,
  auth,
  wrap(async (req) => {
    const b = db.data.bounties[String(req.params.id)];
    if (!b) throw new GameError("No such bounty.", 404);
    if (env.geminiMode !== "mock") throw new GameError("Settling by hand only works with mock Gemini. Live markets settle on Gemini's schedule.");
    const side = req.body?.side === "no" ? "no" : "yes";
    const r = await fetch(`${geminiBaseUrl}/mock/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market: b.market, side }) });
    if (!r.ok) throw new GameError("Mock Gemini refused to settle.");
    await tick();
    return { ok: true };
  }),
);

// ── Badge metadata for wallets and explorers ──────────────────────────
app.get("/meta/:file", (req, res) => {
  const m = /^([a-z-]+)\.(json|png)$/.exec(String(req.params.file));
  if (!m || !BADGE_IDS.includes(m[1])) return void res.status(404).end();
  const id = m[1];
  const def = (BADGES as any)[id];
  const base = env.publicUrl.replace(/\/$/, "");
  if (m[2] === "json")
    return void res.json({
      name: `StakeClash: ${def.name}`,
      symbol: "CLASH",
      description: `${def.desc} Earned in StakeClash, an 8-bit strategy game built on Gemini prediction markets.`,
      image: `${base}/meta/${id}.png`,
      attributes: [{ trait_type: "badge", value: def.name }, { trait_type: "game", value: "StakeClash" }],
    });
  res.type("png").send(badgePng(def.icon));
});

const pngCache = new Map<string, Buffer>();
function badgePng(iconName: string) {
  if (pngCache.has(iconName)) return pngCache.get(iconName)!;
  const N = 24;
  const S = 10;
  const px = new Uint8Array(N * S * N * S * 4);
  const rgb = (c: string) => [parseInt(PALETTE[c as keyof typeof PALETTE].slice(1, 3), 16), parseInt(PALETTE[c as keyof typeof PALETTE].slice(3, 5), 16), parseInt(PALETTE[c as keyof typeof PALETTE].slice(5, 7), 16)];
  const set = (x: number, y: number, c: string) => {
    const [r, g, b] = rgb(c);
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const o = ((y * S + dy) * N * S + x * S + dx) * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
  };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2);
      if (d > 11.5) continue;
      set(x, y, d > 10.5 ? "k" : d > 9 ? (x + y < N ? "z" : "A") : d > 8 ? "a" : y < N / 2 ? "Z" : "K");
    }
  const icon = (SPRITES as any)[`icon_${iconName}`];
  if (icon) icon.px.forEach((row: string, y: number) => [...row].forEach((c, x) => c !== "." && [0, 1].forEach((a) => [0, 1].forEach((b) => set(4 + x * 2 + a, 4 + y * 2 + b, c)))));
  const buf = encodePng(N * S, N * S, px);
  pngCache.set(iconName, buf);
  return buf;
}

// ── Static client ─────────────────────────────────────────────────────
app.use("/shared", express.static(path.join(ROOT, "shared"), { extensions: ["js"] }));
app.use("/fonts", express.static(path.join(ROOT, "node_modules", "@fontsource")));
app.use(express.static(path.join(ROOT, "web")));
app.use("/api", (_req, res) => void res.status(404).json({ error: "not found" }));

app.listen(env.gamePort, () => {
  console.log(`StakeClash on http://localhost:${env.gamePort}  network=${NETWORK} gemini=${env.geminiMode}`);
  void tick();
  setInterval(() => void tick(), 1500);
  setInterval(() => {
    void oddsTick(marketsForOdds); // record Gemini odds; the town crier announces big movers
    void colosseumTick(); // rival warlords answer challenges; settled markets pay the foresight half
  }, 1500);
  resumeCompiling();
  console.log(`intel: ${env.intel ? "live sources (sample data when unreachable)" : "off, sample data only"}`);
});
process.on("SIGTERM", () => {
  flushOdds();
  db.flush();
  process.exit(0);
});
process.on("SIGINT", () => {
  flushOdds();
  db.flush();
  process.exit(0);
});
void fs;
