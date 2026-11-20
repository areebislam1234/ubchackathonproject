// Environment and paths for the server, scripts and local chain.
import path from "node:path";
import dotenv from "dotenv";
import { ROOT, DATA_DIR } from "../shared/paths";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true } as any);

const num = (v: string | undefined, d: number) => (v && v.trim() !== "" ? Number(v) : d);
const str = (v: string | undefined, d = "") => (v && v.trim() !== "" ? v.trim() : d);

export type NetworkName = "local" | "devnet";
export const NETWORK = str(process.env.NETWORK, "local") as NetworkName;
if (NETWORK !== "local" && NETWORK !== "devnet") throw new Error(`NETWORK must be "local" or "devnet", got "${NETWORK}"`);
export const IS_LOCAL = NETWORK === "local";

export const env = {
  gamePort: num(process.env.GAME_PORT, 4000),
  mockGeminiPort: num(process.env.MOCK_GEMINI_PORT, 4100),
  localChainPort: num(process.env.LOCAL_CHAIN_PORT, 8899),
  geminiMode: str(process.env.GEMINI_MODE, "mock") as "mock" | "live",
  quicknodeWebhookSecret: str(process.env.QUICKNODE_WEBHOOK_SECRET),
  publicUrl: str(process.env.PUBLIC_URL, `http://localhost:${num(process.env.GAME_PORT, 4000)}`),
  authorityKey: str(process.env.SOLANA_AUTHORITY_KEY),
  // Bounty pacing. Short locally so a full loop fits in a demo.
  bountyUpcomingSec: num(process.env.BOUNTY_UPCOMING_SECONDS, IS_LOCAL ? 25 : 120),
  bountyActiveSec: num(process.env.BOUNTY_ACTIVE_SECONDS, IS_LOCAL ? 240 : 900),
  bountyTarget: num(process.env.BOUNTY_TARGET, 14),
  bots: str(process.env.BOTS, "on") !== "off",
  // Dev panel (edit gold, levels, spawn/settle bounties…). On for demos; DEV_TOOLS=off to hide it.
  devTools: str(process.env.DEV_TOOLS, "on") !== "off",
  // Intelligence reports from live public data (ESPN, GDELT, World Bank, Open-Meteo, Gemini, QuickNode).
  // INTEL=off uses clearly labelled sample data only.
  intel: str(process.env.INTEL, "on") !== "off",
};

export const solanaRpcUrl = str(process.env.SOLANA_RPC_URL, IS_LOCAL ? `http://127.0.0.1:${env.localChainPort}` : "https://api.devnet.solana.com");
export const geminiBaseUrl = str(process.env.GEMINI_BASE_URL, env.geminiMode === "mock" ? `http://127.0.0.1:${env.mockGeminiPort}` : "https://api.gemini.com");
export const gameUrl = `http://127.0.0.1:${env.gamePort}`;
export const networkDataDir = path.join(DATA_DIR, NETWORK);
export const explorerTx = (sig: string) => (IS_LOCAL ? null : `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
export const explorerAddress = (a: string) => (IS_LOCAL ? null : `https://explorer.solana.com/address/${a}?cluster=devnet`);
export { ROOT, DATA_DIR };
