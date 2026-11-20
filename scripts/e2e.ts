// End-to-end test on a fresh stack with its own ports and data folder (your game stays untouched).
//   npm test
// Covers the world, blind bounties, exploration, battles (and that replays match the server),
// rivals, rewards by placement, the revealed question, predictions and Gemini settlement,
// fortress and army rules, Solana wallet linking, badge minting confirmed via the Stream,
// sealed results, webhook security and de-duplication, and the QuickNode filter itself; then boss
// lairs, boss battles, loot and the Bag, and intelligence reports.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "stakeclash-e2e-"));
Object.assign(process.env, {
  STAKECLASH_DATA_DIR: DATA,
  NETWORK: "local",
  GEMINI_MODE: "mock",
  GAME_PORT: "4610",
  MOCK_GEMINI_PORT: "4710",
  LOCAL_CHAIN_PORT: "8910",
  QUICKNODE_WEBHOOK_SECRET: "e2e-secret-0123456789abcdef0123456789",
  BOUNTY_UPCOMING_SECONDS: "600",
  BOUNTY_ACTIVE_SECONDS: "900",
  PUBLIC_URL: "http://localhost:4610",
  INTEL: "off", // reports use labelled sample data, so the suite needs no internet
});
const { ROOT, gameUrl, geminiBaseUrl } = await import("../server/config");
const { generateWorld, REALMS, realmForMarket, WORLD_SEED, placeBossLairs } = await import("../shared/world.js");
const { mulberry32 } = await import("../shared/rng.js");
const { parseScenario } = await import("../server/intel/scenario");
const { simulate } = await import("../shared/battle.js");
const { payoutFor, crystalsFor, brier, TIERS, BOSSES, BOSS_TIERS, rollLoot } = await import("../shared/rules.js");
const { signStreamPayload } = await import("../shared/hmac");
const { buildFilter, runFilter } = await import("../server/chain/filter");

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "  ✔" : "  ✘"} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await sleep(300);
  }
  throw new Error(`timed out: ${what}`);
}
async function call(token: string | null, method: string, p: string, body?: unknown) {
  const r = await fetch(gameUrl + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(`http://127.0.0.1:${process.env.LOCAL_CHAIN_PORT}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as any).result;
}

console.log("starting a fresh stack…");
const ready = path.join(DATA, "ready");
const dev = spawn(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/dev.ts", "--fresh"], { cwd: ROOT, env: { ...process.env, DEV_READY_FILE: ready }, stdio: ["ignore", "pipe", "pipe"] });
const log: string[] = [];
dev.stdout.on("data", (d) => log.push(d.toString()));
dev.stderr.on("data", (d) => log.push(d.toString()));

try {
  await until("stack ready", async () => fs.existsSync(ready), 120_000);
  const world = generateWorld(WORLD_SEED);

  console.log("\nWorld");
  const again = generateWorld(WORLD_SEED);
  ok(Buffer.compare(Buffer.from(world.terrain), Buffer.from(again.terrain)) === 0 && Buffer.compare(Buffer.from(world.objects), Buffer.from(again.objects)) === 0, `world generation is deterministic (${world.W}×${world.H} tiles, ${world.towns.length} towns)`);
  const reach = world.reachable.reduce((a: number, b: number) => a + b, 0);
  ok(reach > 30000, `${reach.toLocaleString()} walkable tiles are reachable from the spawn`);

  console.log("\nAccounts");
  ok((await call(null, "POST", "/api/register", { name: "Alice", password: "short" })).status === 400, "passwords need 8+ characters");
  const alice = (await call(null, "POST", "/api/register", { name: "Alice", password: "alice-secret-1" })).body;
  const bob = (await call(null, "POST", "/api/register", { name: "Bob", password: "bob-secret-22" })).body;
  ok(alice.token && bob.token && alice.player.gold === 500, "two warlords register and start with 500 gold and an army");
  ok((await call(null, "POST", "/api/register", { name: "ALICE", password: "something-else" })).status === 409, "names are unique, ignoring case");
  ok((await call(null, "POST", "/api/login", { name: "alice", password: "wrong-password" })).status === 401, "a wrong password is refused");
  const second = await call(null, "POST", "/api/login", { name: "alice", password: "alice-secret-1" });
  ok(second.status === 200 && second.body.player.id === alice.player.id, "signing in with the right password returns the same warlord");
  await call(second.body.token, "POST", "/api/logout", {});
  ok((await call(second.body.token, "GET", "/api/me")).status === 401 && (await call(alice.token, "GET", "/api/me")).status === 200, "logging out ends that session only");
  for (let i = 0; i < 5; i++) await call(null, "POST", "/api/login", { name: "bob", password: `guess-${i}-xxxx` });
  ok((await call(null, "POST", "/api/login", { name: "bob", password: "bob-secret-22" })).status === 429, "5 wrong passwords lock the name for a minute");
  const db = JSON.parse(fs.readFileSync(path.join(DATA, "local", "db.json"), "utf8"));
  ok(!JSON.stringify(db).includes("alice-secret-1") && db.players[alice.player.id].auth.algo === "scrypt", "passwords are stored only as salted scrypt hashes");

  console.log("\nHome base");
  const home = alice.player.home;
  const hi = home.y * world.W + home.x;
  ok(home && world.reachable[(home.y + 2) * world.W + home.x] === 1 && REALMS[world.realm[hi]].id === "crownlands", `each warlord gets a fortress in the Crownlands (${home.x}, ${home.y})`);
  ok(alice.player.home.x !== bob.player.home.x || alice.player.home.y !== bob.player.home.y, "fortresses don't share a plot");
  const rc = await call(alice.token, "POST", "/api/recall", {});
  ok(rc.status === 200 && rc.body.x === home.x && rc.body.y === home.y + 2, "recall takes you to the gate of your fortress");

  console.log("\nBlind bounties");
  const list = await until("bounties spawned", async () => {
    const r = (await call(alice.token, "GET", "/api/bounties")).body;
    return r.bounties.length >= 10 && r;
  });
  ok(list.bounties.every((b: any) => !b.discovered && b.rumor && b.x === undefined), "undiscovered bounties only show a rumour circle, never their position");
  ok(!JSON.stringify(list).match(/question|GEMI-/), "the bounty list never leaks a market or question");
  const target = list.bounties.find((b: any) => b.status === "active" && b.tier === "common") ?? list.bounties.find((b: any) => b.status === "active");
  const activeRealms = new Set(list.bounties.filter((b: any) => b.status === "active").map((b: any) => b.realm));
  ok(REALMS.every((r: any) => activeRealms.has(r.id)), "every realm has a bounty you can fight in right now");
  const sealed = (await call(alice.token, "GET", `/api/bounties/${target.id}`)).body;
  ok(sealed.question === null && sealed.market === null, `${target.id}'s question is sealed before the battles end`);

  console.log("\nExploration");
  const cells: number[] = [];
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) cells.push(y * 48 + x);
  const ex = (await call(alice.token, "POST", "/api/explore", { cells, pos: target.rumor })).body;
  ok(ex.discovered.includes(target.id), "walking into the rumour area discovers the camp");
  const found = (await call(alice.token, "GET", "/api/bounties")).body.bounties;
  const tb = found.find((b: any) => b.id === target.id);
  ok(tb.discovered && Number.isInteger(tb.x), "once found, the camp's exact position is on the map");
  const tile = tb.y * world.W + tb.x;
  ok(world.reachable[tile] === 1 && REALMS[world.realm[tile]].id === tb.realm, `the camp stands on reachable land in ${REALMS[world.realm[tile]].name}`);
  const det = (await call(alice.token, "GET", `/api/bounties/${target.id}`)).body;
  ok(REALMS.find((r: any) => r.id === tb.realm)!.category === det.category, `the realm tells you the market's category (${det.category}) but not the question`);

  console.log("\nEntering and battling");
  const fee = TIERS[det.tier as keyof typeof TIERS].entry;
  const en = await call(alice.token, "POST", `/api/bounties/${target.id}/enter`, {});
  const me1 = (await call(alice.token, "GET", "/api/me")).body;
  ok(en.status === 200 && me1.gold === 500 - fee, `entry costs ${fee} gold`);
  ok((await call(alice.token, "POST", `/api/bounties/${target.id}/enter`, {})).status === 400, "can't enter twice");
  ok((await call(bob.token, "POST", `/api/bounties/${target.id}/attack`, { opponent: "guardian" })).status === 400, "can't attack without entering");
  const atk = (await call(alice.token, "POST", `/api/bounties/${target.id}/attack`, { opponent: "guardian", units: { infantry: 6, archer: 4 } })).body;
  const inCombat = await call(alice.token, "POST", "/api/recall", {});
  ok(inCombat.status === 400 && /combat/.test(inCombat.body.error), "you can't recall home right after a battle");
  const rec = atk.battle;
  const replay = simulate({ attacker: { units: rec.attacker.units, levels: rec.attacker.levels, boosts: rec.attacker.boosts }, defender: rec.defender, seed: rec.seed });
  ok(replay.score === rec.result.score && replay.winner === rec.result.winner && replay.ticks === rec.result.ticks, `the browser replay reproduces the server's battle exactly (${rec.result.winner}, +${rec.result.score})`);
  const me2 = (await call(alice.token, "GET", "/api/me")).body;
  ok(me2.army.infantry === 6 - (rec.result.lost.infantry ?? 0) && me2.army.archer === 4 - (rec.result.lost.archer ?? 0), "fallen units are removed from your army");
  const after = (await call(alice.token, "GET", `/api/bounties/${target.id}`)).body;
  ok(after.you.score - after.you.defense === rec.result.score && after.you.attacksLeft === 2, "the score counts and an attack is used");
  await call(alice.token, "POST", "/api/army/train", { unit: "infantry", count: 4 });
  await call(alice.token, "POST", `/api/bounties/${target.id}/attack`, { opponent: "guardian" });
  await call(alice.token, "POST", `/api/bounties/${target.id}/attack`, { opponent: "guardian" });
  ok((await call(alice.token, "POST", `/api/bounties/${target.id}/attack`, { opponent: "guardian" })).status === 400, "only 3 attacks per bounty");
  const rivals = await until("rival warlords join", async () => {
    const r = (await call(alice.token, "GET", `/api/bounties/${target.id}`)).body;
    return r.leaderboard.some((x: any) => x.bot) && r;
  });
  ok(rivals.leaderboard.some((x: any) => x.bot), `rival warlords joined (${rivals.participants} on the board)`);

  console.log("\nEnd of battles: rewards and the reveal");
  const goldBefore = (await call(alice.token, "GET", "/api/me")).body.gold;
  await call(alice.token, "POST", `/api/dev/end/${target.id}`, {});
  const rev = (await call(alice.token, "GET", `/api/bounties/${target.id}`)).body;
  const mine = rev.results.you;
  const goldAfter = (await call(alice.token, "GET", "/api/me")).body.gold;
  ok(rev.status === "revealed" && typeof rev.question === "string" && rev.market?.startsWith("GEMI-"), `entrants see the question: "${rev.question}"`);
  ok(goldAfter - goldBefore === mine.gold, `placement #${mine.rank} paid ${mine.gold} gold`);
  ok(mine.stakeCap === (mine.rank <= 3 ? TIERS[det.tier as keyof typeof TIERS].stake[mine.rank - 1] * (det.featured ? 1.5 : 1) : 0), `stake allowance follows placement (${mine.stakeCap} gold)`);
  const outsider = (await call(bob.token, "GET", `/api/bounties/${target.id}`)).body;
  ok(outsider.question === null, "players who didn't fight never see the question");
  const mkt = realmForMarket(rev.category, rev.question);
  ok(mkt === rev.realm, "the market's category matches the realm it spawned in");
  const refill = await until("the realm gets a new bounty", async () => {
    const r = (await call(alice.token, "GET", "/api/bounties")).body.bounties;
    return r.some((b: any) => b.realm === rev.realm && b.status === "active" && b.id !== target.id) && r;
  }, 10_000).catch(() => null);
  ok(refill, `${REALMS.find((r: any) => r.id === rev.realm)!.name} is never left without an active bounty`);

  console.log("\nPrediction and Gemini settlement");
  ok((await call(bob.token, "POST", `/api/bounties/${target.id}/predict`, { side: "yes", confBps: 7000, stake: 0 })).status === 400, "outsiders can't call the question");
  ok((await call(alice.token, "POST", `/api/bounties/${target.id}/predict`, { side: "yes", confBps: 7000, stake: mine.stakeCap + 50 })).status === 400, "can't stake more than your placement allows");
  const stake = Math.min(mine.stakeCap, 40);
  const pr = (await call(alice.token, "POST", `/api/bounties/${target.id}/predict`, { side: "yes", confBps: 8000, stake })).body;
  const price = pr.prediction.priceBps;
  ok(price === rev.quote.askBps || price > 0, `YES bought at Gemini's ask (${price / 100}¢)`);
  const g0 = (await call(alice.token, "GET", "/api/me")).body;
  await call(alice.token, "POST", `/api/dev/settle/${target.id}`, { side: "yes" });
  const settled = await until("settlement", async () => {
    const r = (await call(alice.token, "GET", `/api/bounties/${target.id}`)).body;
    return r.status === "resolved" && r;
  });
  const g1 = (await call(alice.token, "GET", "/api/me")).body;
  const expectPay = payoutFor(stake, price);
  const expectCrystals = crystalsFor(brier("yes", 8000, "yes"));
  ok(settled.prediction.correct && settled.prediction.payout === expectPay && g1.gold - g0.gold === expectPay, `a right call pays stake ÷ price: ${stake} → ${expectPay} gold`);
  ok(g1.crystals - g0.crystals === expectCrystals && expectCrystals === 50, `80% sure and right: Brier 0.04 → +${expectCrystals} crystals`);

  console.log("\nFortress and army");
  ok((await call(bob.token, "POST", "/api/fortress/upgrade", { building: "keep" })).status === 400, "the Keep needs crystals: Bob has none");
  ok((await call(bob.token, "POST", "/api/fortress/upgrade", { building: "barracks" })).status === 200, "the Barracks upgrade with gold");
  ok((await call(bob.token, "POST", "/api/fortress/upgrade", { building: "barracks" })).status === 400, "buildings can't rise more than one level above the Keep");
  ok((await call(bob.token, "POST", "/api/army/train", { unit: "siege", count: 1 })).status === 400, "Siege stays locked until Barracks level 4");
  ok((await call(bob.token, "POST", "/api/army/train", { unit: "tank", count: 1 })).status === 200, "Tanks unlock at Barracks level 2");
  ok((await call(alice.token, "POST", "/api/fortress/upgrade", { building: "keep" })).status === 200, "Alice's crystals raise her Keep to level 2");

  console.log("\nSolana: wallet, badges, sealed results");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const { getAddressDecoder } = await import("@solana/kit");
  const address = getAddressDecoder().decode(rawPub);
  const ch = (await call(alice.token, "POST", "/api/wallet/challenge", { address })).body;
  const forged = crypto.sign(null, Buffer.from(ch.message), crypto.generateKeyPairSync("ed25519").privateKey).toString("base64");
  ok((await call(alice.token, "POST", "/api/wallet/link", { address, signature: forged })).status === 400, "a signature from a different key is rejected");
  const ch2 = (await call(alice.token, "POST", "/api/wallet/challenge", { address })).body;
  const sig = crypto.sign(null, Buffer.from(ch2.message), privateKey).toString("base64");
  ok((await call(alice.token, "POST", "/api/wallet/link", { address, signature: sig, kind: "bank" })).status === 400, "unknown wallet types are refused");
  const ch3 = (await call(alice.token, "POST", "/api/wallet/challenge", { address })).body;
  const sig3 = crypto.sign(null, Buffer.from(ch3.message), privateKey).toString("base64");
  const link = await call(alice.token, "POST", "/api/wallet/link", { address, signature: sig3, kind: "ingame" });
  ok(link.status === 200 && link.body.wallet.address === address && link.body.wallet.kind === "ingame" && link.body.wallet.verified, "an in-game wallet links by signing a message (ed25519 verified)");
  const earned = Object.keys(link.body.badges);
  const minted = await until("badges confirmed by the Stream", async () => {
    const m = (await call(alice.token, "GET", "/api/me")).body;
    return Object.values(m.badges).every((b: any) => b.status === "onchain") && m;
  }, 40_000);
  ok(earned.length >= 2 && earned.every((b) => minted.onchain[b] === 1), `earned badges minted to the wallet and confirmed via the Stream (${earned.join(", ")})`);
  const ata = await rpc("getSignatureStatuses", [[minted.badges[earned[0]].signature]]);
  ok(ata.value[0]?.confirmationStatus === "finalized", "the mint transaction is on the local Solana chain");
  const sealedRes = (await call(alice.token, "GET", `/api/bounties/${target.id}`)).body.results.seal;
  ok(sealedRes.status === "onchain" && sealedRes.verified === true, "final standings are sealed in a memo and verified against the table");

  // receive-only addresses, and switching wallets
  ok((await call(bob.token, "POST", "/api/wallet/address", { address: "not-a-real-address" })).status === 400, "a pasted address must be a real Solana address");
  const exAll: number[] = [];
  for (let i = 0; i < 48 * 48; i++) exAll.push(i);
  await call(bob.token, "POST", "/api/explore", { cells: exAll, pos: { x: world.spawn.x, y: world.spawn.y } });
  const bobBadges = (await call(bob.token, "GET", "/api/me")).body.badges;
  ok(bobBadges.cartographer?.status === "unclaimed", "badges earned before linking a wallet wait as unclaimed");
  const bobAddr = getAddressDecoder().decode(crypto.randomBytes(32));
  const recv = (await call(bob.token, "POST", "/api/wallet/address", { address: bobAddr })).body;
  ok(recv.wallet.kind === "address" && recv.wallet.verified === false, "a pasted address links as receive-only (unverified)");
  const bobMinted = await until("Bob's badge minted", async () => {
    const m = (await call(bob.token, "GET", "/api/me")).body;
    return m.badges.cartographer?.status === "onchain" && m;
  }, 30_000).catch(() => null);
  ok(bobMinted?.onchain?.cartographer === 1 && bobMinted.badges.cartographer.owner === bobAddr, "unclaimed badges mint to the new address as soon as it's linked");
  const un = (await call(bob.token, "POST", "/api/wallet/unlink", {})).body;
  ok(un.wallet === null && (await call(bob.token, "POST", "/api/wallet/unlink", {})).status === 400, "a wallet can be unlinked (and switched)");

  console.log("\nQuickNode Streams");
  const bad = await fetch(`${gameUrl}/webhooks/quicknode`, { method: "POST", headers: { "content-type": "application/json", "x-qn-nonce": "x", "x-qn-timestamp": "1", "x-qn-signature": "nope" }, body: "{}" });
  ok(bad.status === 401, "a webhook with a bad signature is rejected");
  const health = (await call(null, "GET", "/api/health")).body;
  const ev = (await call(null, "GET", "/api/chain/events")).body.events[0];
  const payload = JSON.stringify({ events: [{ signature: ev.signature, slot: ev.slot, blockTime: ev.blockTime, memos: ev.memos, badges: ev.badges }] });
  const dup = await fetch(`${gameUrl}/webhooks/quicknode`, { method: "POST", headers: { "content-type": "application/json", ...signStreamPayload(process.env.QUICKNODE_WEBHOOK_SECRET!, payload) }, body: payload });
  const dupBody: any = await dup.json();
  ok(dup.status === 200 && dupBody.applied === 0, "a redelivered transaction is ignored (de-duplicated by signature)");
  ok(health.streamDeliveries > 0 && health.chainEvents >= earned.length + 1, `the game state came from ${health.streamDeliveries} Stream deliveries`);
  // Filter on a real block from the chain, and on devnet-style shapes
  const auth = health.chain.authority;
  const mints = Object.values(health.chain.mints) as string[];
  const filter = buildFilter(auth, mints);
  const slot = minted.badges[earned[0]] && (await rpc("getSignatureStatuses", [[minted.badges[earned[0]].signature]])).value[0].slot;
  const block = await rpc("getBlock", [slot]);
  const out = runFilter(filter, { data: [block], metadata: {} });
  ok(out?.events?.[0]?.memos?.[0]?.startsWith("stakeclash:v1:badge:") && out.events[0].badges[0].post === 1, "the filter pulls the memo and badge balance out of a real block");
  const devnetStyle = {
    blockTime: 1,
    parentSlot: 99,
    transactions: [
      { meta: { err: null, logMessages: ['Program log: Memo (len 30): "stakeclash:v1:result:B-1:abc"'], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: ["S1"], message: { accountKeys: [{ pubkey: auth }], instructions: [] } } },
      { meta: { err: null, logMessages: [], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: ["S2"], message: { accountKeys: [auth], instructions: [{ program: "spl-memo", parsed: "stakeclash:v1:badge:oracle:p_x" }] } } },
      { meta: { err: { InstructionError: [0, "Custom"] }, logMessages: ["Program log: stakeclash:v1:badge:oracle:p_y"] }, transaction: { signatures: ["S3"], message: { accountKeys: [auth] } } },
      { meta: { err: null, logMessages: ["Program log: stakeclash:v1:badge:oracle:p_z"] }, transaction: { signatures: ["S4"], message: { accountKeys: ["SomeoneElse111"] } } },
    ],
  };
  const out2 = runFilter(filter, { data: [devnetStyle], metadata: {} });
  ok(out2.events.length === 2 && out2.events[0].slot === 100 && out2.events[1].memos[0] === "stakeclash:v1:badge:oracle:p_x", "it reads devnet-style memos, skips failed and unrelated transactions");
  ok(runFilter(filter, { data: [{ blockTime: 1, transactions: [] }], metadata: {} }) === null, "blocks with nothing for the game return null (no delivery)");

  console.log("\nDev tools");
  const dv = (await call(bob.token, "POST", "/api/dev/player", { gold: 25000, crystals: 300, buildings: { keep: 9, barracks: 3 }, unitLevels: { archer: 4 }, army: { cavalry: 6 } })).body;
  ok(dv.gold === 25000 && dv.crystals === 300 && dv.buildings.keep === 5 && dv.buildings.barracks === 3 && dv.unitLevels.archer === 4 && dv.army.cavalry === 6, "the dev panel sets gold, crystals, levels and army (clamped to valid ranges)");
  const spawned = (await call(bob.token, "POST", "/api/dev/spawn", { realm: "sunscar", tier: "epic", featured: true })).body;
  const sp = (await call(bob.token, "GET", "/api/dev/bounties")).body.bounties.find((b: any) => b.id === spawned.id);
  ok(sp && sp.realm === "sunscar" && sp.tier === "epic" && sp.featured && sp.status === "active", `dev spawn puts an active bounty where you ask (${spawned.id})`);
  await call(bob.token, "POST", "/api/dev/reveal", {});
  const seen = (await call(bob.token, "GET", "/api/bounties")).body.bounties;
  ok(seen.every((b: any) => b.discovered), "reveal uncovers every bounty on the map");
  const rs = (await call(bob.token, "POST", "/api/dev/reset", {})).body;
  ok(rs.gold === 500 && rs.buildings.keep === 1 && rs.army.cavalry === 0, "reset puts the warlord back to a fresh start");

  console.log("\nBoss lairs");
  const lairs = placeBossLairs(world, BOSSES);
  ok(lairs.length === Object.keys(BOSSES).length && JSON.stringify(placeBossLairs(generateWorld(WORLD_SEED), BOSSES)) === JSON.stringify(lairs), `all ${lairs.length} lairs are placed, deterministically`);
  ok(lairs.every((l: any) => world.reachable[(l.y + 1) * world.W + l.x] === 1 && REALMS[world.realm[l.y * world.W + l.x]].id === l.realm), "every lair stands on reachable land in its own realm");
  const carol = (await call(null, "POST", "/api/register", { name: "Carol", password: "carol-secret-3" })).body;
  const ct = carol.token;
  const common = lairs.find((l: any) => l.tier === "common")!;
  const legend = lairs.find((l: any) => l.tier === "legendary")!;
  const near = (l: any) => ({ x: l.x, y: l.y + 2 });
  ok((await call(ct, "GET", `/api/bosses/${legend.id}`)).status === 404, "an undiscovered lair stays hidden");
  const disc = (await call(ct, "POST", "/api/explore", { cells: [], pos: near(common) })).body;
  ok(disc.lairs.includes(common.id), "walking up to a lair discovers it");
  const army0 = { infantry: 6, archer: 4 };
  ok((await call(ct, "POST", `/api/bosses/${common.id}/challenge`, { units: army0, requestId: "far-away-001", pos: { x: common.x + 40, y: common.y } })).status === 400, "you must stand at the lair to challenge it");
  const bg0 = (await call(ct, "GET", "/api/me")).body.gold;
  const fightB = (await call(ct, "POST", `/api/bosses/${common.id}/challenge`, { units: army0, requestId: "boss-fight-001", pos: near(common) })).body;
  ok(fightB.win === true && fightB.loot.gold > 0, "the starting army beats a common boss and wins loot");
  const bossReplay = simulate({ attacker: { units: fightB.battle.attacker.units, levels: fightB.battle.attacker.levels, boosts: fightB.battle.attacker.boosts }, defender: fightB.battle.defender, seed: fightB.battle.seed, record: true });
  ok(bossReplay.score === fightB.battle.result.score && (bossReplay as any).roster.some((u: any) => u.type === "boss"), "boss fights replay exactly in the browser, champion included");
  const dupB = (await call(ct, "POST", `/api/bosses/${common.id}/challenge`, { units: army0, requestId: "boss-fight-001", pos: near(common) })).body;
  const bg1 = (await call(ct, "GET", "/api/me")).body.gold;
  ok(dupB.battle.id === fightB.battle.id && bg1 === bg0 + fightB.loot.goldLanded, "a duplicate request returns the same result and pays only once");
  ok((await call(ct, "POST", `/api/bosses/${common.id}/challenge`, { units: army0, requestId: "boss-fight-002", pos: near(common) })).status === 429, "the boss retreats after every attempt (cooldown)");
  await call(ct, "POST", "/api/explore", { cells: [], pos: near(legend) });
  await call(ct, "POST", "/api/dev/player", { army: { infantry: 6, archer: 4 } });
  const race = await Promise.all(["race-a-0001", "race-b-0001"].map((id) => call(ct, "POST", `/api/bosses/${legend.id}/challenge`, { units: { infantry: 2 }, requestId: id, pos: near(legend) })));
  ok(race.map((r) => r.status).sort().join() === "200,429", "two challenges at once: exactly one fights");
  ok(race.find((r) => r.status === 200)!.body.win === false, "a tiny army loses to a legendary boss");

  console.log("\nLoot and the Bag");
  for (const tier of Object.keys(BOSS_TIERS)) {
    const rnd = mulberry32(7);
    let n = 0;
    for (let i = 0; i < 5000; i++) if (rollLoot(tier, rnd).intel) n++;
    const want = (BOSS_TIERS as any)[tier].intel.chance;
    ok(Math.abs(n / 5000 - want) < 0.03, `${tier} bosses drop intel ${(n / 5000).toFixed(2)} of the time (configured ${want}), never guaranteed`);
  }
  const maxed = { gold: 5000, buildings: { keep: 5, barracks: 5, training: 5, vault: 5, towers: 5 }, army: { infantry: 6, archer: 6, tank: 3, cavalry: 3, siege: 2 }, unitLevels: { infantry: 5, archer: 5, tank: 5, cavalry: 5, siege: 5 } };
  await call(ct, "POST", "/api/dev/player", { ...maxed, buildings: { ...maxed.buildings, barracks: 2 }, inventory: { materials: { timber: 10 }, manuals: { infantry: 1 } } });
  const upB = (await call(ct, "POST", "/api/fortress/upgrade", { building: "barracks", useMaterials: true })).body;
  ok(upB.materialsUsed === 7 && upB.goldPaid === 300 - 140, "materials take gold off a building upgrade, up to half");
  await call(ct, "POST", "/api/dev/player", { unitLevels: { infantry: 2 } });
  const man = await call(ct, "POST", "/api/army/upgrade", { unit: "infantry", use: "manual" });
  ok(man.status === 200 && man.body.level === 3, "a training manual levels a unit for free");
  await call(ct, "POST", "/api/dev/player", { buildings: { vault: 1 }, inventory: { relics: ["ledger-scale"] } });
  ok((await call(ct, "GET", "/api/me")).body.derived.vaultCap === Math.round(1500 * 1.05), "relics give permanent bonuses (vault +5%)");

  console.log("\nIntelligence");
  const sc = parseScenario({ ticker: "NBAMVP27", title: "2027 NBA MVP", category: "Sports", contracts: [{ label: "Shai Gilgeous-Alexander wins MVP", instrumentSymbol: "A" }, { label: "Nikola Jokić wins MVP", instrumentSymbol: "B" }] }, { label: "Shai Gilgeous-Alexander wins MVP", instrumentSymbol: "A" });
  ok(sc.type === "award-race" && sc.subject.name === "Shai Gilgeous-Alexander" && sc.rivals[0] === "Nikola Jokić" && sc.league === "NBA", "an MVP market is about that player, with the other contracts as rivals");
  const tot = parseScenario({ ticker: "NBA-2611200100-LAC-SAS-T", title: "Los Angeles C vs San Antonio: Total Points", category: "Sports", participants: [{ name: "San Antonio Spurs" }, { name: "Los Angeles Clippers" }] }, { label: "More than 231.5 points scored", instrumentSymbol: "T", strike: { type: "over", value: "231.5" } });
  ok(tot.type === "game-total" && tot.condition?.value === 231.5 && tot.teams?.length === 2, "a points-total market reads the line and both teams");
  const btc = parseScenario({ ticker: "BTC2611200300", title: "BTC price today at 10pm EST", category: "Crypto" }, { label: "$61,200 or above", instrumentSymbol: "C", strike: { type: "above", value: "61200" } });
  ok(btc.type === "price-threshold" && btc.symbol === "BTC" && btc.condition?.value === 61200, "a price market reads the coin and the strike");
  const sp2 = parseScenario({ ticker: "NBA-1-NYK-MIN-S", title: "New York vs Minnesota: Point Spread", category: "Sports" }, { label: "New York wins by more than 9.5 points", instrumentSymbol: "S" });
  ok(sp2.type === "game-spread" && sp2.subject.name === "New York" && sp2.condition?.value === 9.5, "a spread market reads the team and the margin");
  // reports (INTEL=off in this suite: sample data, clearly labelled)
  await call(ct, "POST", "/api/dev/player", maxed);
  await call(ct, "POST", "/api/dev/boss-cooldowns", {});
  let drop: any = null;
  for (let i = 0; i < 6 && !drop; i++) {
    await call(ct, "POST", "/api/dev/player", { army: maxed.army });
    await call(ct, "POST", "/api/dev/boss-cooldowns", {});
    await call(ct, "POST", "/api/dev/next-intel", { rarity: "epic" });
    const f = (await call(ct, "POST", `/api/bosses/${legend.id}/challenge`, { units: maxed.army, requestId: `intel-${i}-0001`, pos: near(legend) })).body;
    if (f.win) drop = f.loot.intel;
  }
  ok(drop?.rarity === "epic", "a boss win can drop an intelligence report");
  const filled = await until("report decoded", async () => {
    const r = (await call(ct, "GET", "/api/intel")).body.reports.find((x: any) => x.id === drop.id);
    return r?.status === "ready" && r;
  });
  ok(filled.sections.length > 0 && filled.live === false && filled.sections.every((s: any) => s.live === false), "with live data unavailable the report is filled and stamped as sample data");
  ok(!/https?:\/\//.test(JSON.stringify(filled)) && !("_provider" in filled), "reports carry no links and no internal source ids");
  const sealedQs = (await call(ct, "GET", "/api/dev/bounties")).body.bounties.filter((b: any) => b.status === "active" || b.status === "upcoming").map((b: any) => b.question);
  ok(!filled.market || !sealedQs.includes(filled.market.question), "a report is never built from a bounty's sealed question");
  const hook2 = JSON.stringify({ events: [], network: [{ slot: 5000, blockTime: 1, txCount: 10, failed: 1, vote: 6, programs: {}, transfers: {} }] });
  const n1: any = await (await fetch(`${gameUrl}/webhooks/quicknode`, { method: "POST", headers: { "content-type": "application/json", ...signStreamPayload(process.env.QUICKNODE_WEBHOOK_SECRET!, hook2) }, body: hook2 })).json();
  const n2: any = await (await fetch(`${gameUrl}/webhooks/quicknode`, { method: "POST", headers: { "content-type": "application/json", ...signStreamPayload(process.env.QUICKNODE_WEBHOOK_SECRET!, hook2) }, body: hook2 })).json();
  ok(n1.network === 1 && n2.network === 0, "Stream network samples are stored once per slot");
  const sampled = runFilter(filter, { data: [{ slot: 150, blockTime: 1, transactions: [{ meta: { err: null }, transaction: { signatures: ["N1"], message: { accountKeys: ["x"], instructions: [] } } }] }], metadata: {} });
  ok(sampled?.network?.[0]?.slot === 150 && sampled.events.length === 0, "the filter samples one block in every 50 for network activity");

  console.log("\nBadge metadata");
  const meta = await (await fetch(`${gameUrl}/meta/oracle.json`)).json();
  const png = await fetch(`${gameUrl}/meta/oracle.png`);
  ok(meta.name === "StakeClash: Oracle" && meta.image.endsWith("/meta/oracle.png") && png.headers.get("content-type") === "image/png", "each badge has wallet-ready metadata and a pixel-art image");
} catch (e) {
  failures++;
  console.error("\n✘", e instanceof Error ? e.message : e);
  console.error("\n--- last output ---\n" + log.join("").replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(-30).join("\n"));
} finally {
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  dev.kill("SIGTERM");
  setTimeout(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  }, 800);
}
void geminiBaseUrl;
