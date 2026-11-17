import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, resolved from this file so scripts work from any working directory. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Local state. STAKECLASH_DATA_DIR lets the test suite use its own folder. */
export const DATA_DIR = process.env.STAKECLASH_DATA_DIR ? path.resolve(process.env.STAKECLASH_DATA_DIR) : path.join(ROOT, ".data");
