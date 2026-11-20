// One command to run everything.
//   npm run dev               local Solana (LiteSVM) + mock Gemini + game server + stream relay
//   npm run dev -- --fresh    same, but wipe local progress and the local chain first
//   NETWORK=devnet npm run dev  game server against devnet (QuickNode Stream delivers events;
//                               USE_LOCAL_STREAM=1 polls devnet instead while you set the Stream up)
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IS_LOCAL, NETWORK, ROOT, env, networkDataDir, solanaRpcUrl } from "../server/config";

const children: ChildProcess[] = [];
const COLORS = [36, 35, 33, 32, 34, 31];
// Run tsx through node directly so this also works on Windows, where .bin/tsx is a shell shim.
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
let stopping = false;

function run(name: string, script: string, quiet = false): ChildProcess {
  const tag = `\x1b[${COLORS[children.length % COLORS.length]}m${name.padEnd(7)}\x1b[0m`;
  const child = spawn(process.execPath, [TSX_CLI, script], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const pipe = (s: NodeJS.ReadableStream) =>
    s.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n")) if (l.trim() && !quiet) console.log(`${tag} ${l}`);
    });
  pipe(child.stdout!);
  pipe(child.stderr!);
  child.on("exit", (code) => {
    if (!stopping && code) console.log(`${tag} exited with code ${code}`);
    // a dead server/chain/mock must not leave a zombie supervisor behind: exit so the host restarts us
    if (!stopping && code && name !== "setup" && name !== "stream") stop(code);
  });
  return child;
}
const once = (name: string, script: string) => new Promise<void>((ok, fail) => run(name, script).on("exit", (c) => (c === 0 ? ok() : fail(new Error(`${name} failed`)))));

async function waitFor(url: string, init?: RequestInit, ms = 60_000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 400);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function main() {
  console.log(`\n▶ Fortune Front  network=${NETWORK}  gemini=${env.geminiMode}\n`);
  if (IS_LOCAL && process.argv.includes("--fresh")) fs.rmSync(networkDataDir, { recursive: true, force: true });
  if (IS_LOCAL) {
    run("chain", "localchain/rpc.ts");
    await waitFor(solanaRpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
    await once("setup", "scripts/setup-solana.ts");
  }
  if (env.geminiMode === "mock") {
    run("gemini", "gemini/mock-server.ts");
    await waitFor(`http://127.0.0.1:${env.mockGeminiPort}/health`);
  }
  run("server", "server/index.ts");
  await waitFor(`http://127.0.0.1:${env.gamePort}/api/config`);
  if (IS_LOCAL || process.env.USE_LOCAL_STREAM === "1") run("stream", "localchain/stream-relay.ts");
  console.log(`\n✔ Play at http://localhost:${env.gamePort}\n  Ctrl+C stops everything\n`);
  if (process.env.DEV_READY_FILE) fs.writeFileSync(process.env.DEV_READY_FILE, "ready");
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  stop(1);
});
