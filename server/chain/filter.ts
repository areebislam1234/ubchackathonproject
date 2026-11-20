// Builds the QuickNode Streams filter with this deployment's authority and badge mints filled in.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "../config";
import { usdcMint } from "./usdc";

/** USDC on devnet; set INTEL_WATCH_MINTS (comma-separated) to watch other tokens. */
const DEFAULT_WATCH = ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"];
export const watchMints = () => (process.env.INTEL_WATCH_MINTS ? process.env.INTEL_WATCH_MINTS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_WATCH);
export const NETWORK_EVERY = Number(process.env.STREAM_NETWORK_EVERY ?? 50);

export function buildFilter(authority: string, mints: string[], opts: { watch?: string[]; networkEvery?: number; depositMint?: string | null } = {}) {
  const template = fs.readFileSync(path.join(ROOT, "streams", "quicknode-solana-filter.template.js"), "utf8");
  return template
    .replace("__AUTHORITY__", authority)
    .replace("__MINTS__", JSON.stringify(mints))
    .replace("__WATCH_MINTS__", JSON.stringify(opts.watch ?? watchMints()))
    .replace("__NETWORK_EVERY__", String(opts.networkEvery ?? NETWORK_EVERY))
    .replace("__DEPOSIT_MINT__", opts.depositMint ?? usdcMint() ?? "");
}

/** Run a filter the way QuickNode does: call main({ data, metadata }) and return its result. */
export function runFilter(source: string, stream: { data: unknown[]; metadata?: unknown }) {
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  return vm.runInContext("main", ctx)(stream);
}
