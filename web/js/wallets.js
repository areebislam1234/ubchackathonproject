// Every way to give the game a Solana wallet. Each "connector" returns { address, sign(bytes) }
// so linking works the same way: the server sends a one-time message, the wallet signs it,
// the server checks the ed25519 signature. Nothing here sends a transaction or spends funds.
//
//   In-game wallet  a keypair made by this browser (WebCrypto Ed25519), kept in localStorage.
//                   Nothing to install; the key can be backed up and imported into Phantom later.
//   Phantom         the injected Phantom provider.
//   Other wallets   anything that registers through the Solana Wallet Standard
//                   (Solflare, Backpack and others), discovered at runtime.
//   Address         receive-only: paste any Solana address (handled by the profile screen).

// ── Base58 (Solana addresses and keys) ────────────────────────────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str.trim()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("That isn't a valid key (unexpected character).");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of str.trim()) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
export const isAddress = (s) => {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim()) && b58decode(s).length === 32;
  } catch {
    return false;
  }
};

// ── In-game wallet ────────────────────────────────────────────────────
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const storeKey = (playerId) => `stakeclash.wallet.${playerId}`;
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function ingameSupported() {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

/** Turn a 32-byte seed into a signing connector (the address is derived from the seed). */
async function fromSeed(seed) {
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const pub = fromB64url((await crypto.subtle.exportKey("jwk", key)).x);
  const secret = new Uint8Array(64);
  secret.set(seed);
  secret.set(pub, 32);
  return {
    address: b58encode(pub),
    secret: b58encode(secret), // Phantom/Solflare "import private key" format
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bytes)),
  };
}

export async function createIngame(playerId) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const w = await fromSeed(pkcs8.slice(-32));
  localStorage.setItem(storeKey(playerId), w.secret);
  return w;
}

/** Restore from a backed-up key: base58 64-byte secret, or a [..64 numbers..] array. */
export async function importIngame(playerId, text) {
  const t = String(text ?? "").trim();
  let bytes;
  if (t.startsWith("[")) bytes = Uint8Array.from(JSON.parse(t));
  else bytes = b58decode(t);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error("A wallet key is 64 bytes (88 characters of base58).");
  const w = await fromSeed(bytes.slice(0, 32));
  if (bytes.length === 64 && b58encode(bytes.slice(32)) !== w.address) throw new Error("That key doesn't match itself. Check you copied all of it.");
  localStorage.setItem(storeKey(playerId), w.secret);
  return w;
}

export async function loadIngame(playerId) {
  const s = localStorage.getItem(storeKey(playerId));
  if (!s) return null;
  try {
    return await fromSeed(b58decode(s).slice(0, 32));
  } catch {
    return null;
  }
}

// ── Phantom ───────────────────────────────────────────────────────────
export function phantomProvider() {
  const p = window.phantom?.solana;
  if (p?.isPhantom) return p;
  return window.solana?.isPhantom ? window.solana : null;
}
export async function connectPhantom() {
  const p = phantomProvider();
  if (!p) throw new Error("Phantom isn't installed in this browser.");
  const { publicKey } = await p.connect();
  return {
    address: publicKey.toString(),
    sign: async (bytes) => {
      const r = await p.signMessage(bytes, "utf8");
      return r.signature ?? r;
    },
  };
}

// ── Wallet Standard discovery (Solflare, Backpack, …) ─────────────────
const standard = [];
const listeners = new Set();
function register(...wallets) {
  for (const w of wallets) if (!standard.includes(w)) standard.push(w);
  for (const fn of listeners) fn();
  return () => {};
}
addEventListener("wallet-standard:register-wallet", (e) => {
  try {
    e.detail({ register });
  } catch {
    /* a wallet that misbehaves shouldn't break the game */
  }
});
try {
  dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register } }));
} catch {
  /* old browsers */
}
export const onWalletsChanged = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** Installed Solana wallets that can connect and sign messages (Phantom listed separately). */
export function standardWallets() {
  return standard.filter(
    (w) => w.chains?.some((c) => String(c).startsWith("solana:")) && w.features?.["standard:connect"] && w.features?.["solana:signMessage"] && !/phantom/i.test(w.name ?? ""),
  );
}
export async function connectStandard(wallet) {
  const { accounts } = await wallet.features["standard:connect"].connect();
  const account = accounts.find((a) => a.chains?.some((c) => String(c).startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error(`${wallet.name} didn't share an account.`);
  return {
    address: account.address,
    sign: async (bytes) => {
      const [out] = await wallet.features["solana:signMessage"].signMessage({ account, message: bytes });
      return out.signature;
    },
  };
}

export const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
