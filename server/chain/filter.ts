// Builds the QuickNode Streams filter with this deployment's authority and badge mints filled in.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "../config";

export function buildFilter(authority: string, mints: string[]) {
  const template = fs.readFileSync(path.join(ROOT, "streams", "quicknode-solana-filter.template.js"), "utf8");
  return template.replace("__AUTHORITY__", authority).replace("__MINTS__", JSON.stringify(mints));
}

/** Run a filter the way QuickNode does: call main({ data, metadata }) and return its result. */
export function runFilter(source: string, stream: { data: unknown[]; metadata?: unknown }) {
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  return vm.runInContext("main", ctx)(stream);
}
