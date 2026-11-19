import crypto from "node:crypto";

// QuickNode Streams webhook signing:
//   headers  x-qn-nonce, x-qn-timestamp, x-qn-signature
//   signature = hex(HMAC-SHA256(securityToken, nonce + timestamp + payload))
// where payload is the UTF-8 JSON body (decompressed if it arrived gzipped).

export function signStreamPayload(secret: string, payload: string) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret).update(nonce + timestamp + payload).digest("hex");
  return { "x-qn-nonce": nonce, "x-qn-timestamp": timestamp, "x-qn-signature": signature };
}

export function verifyStreamSignature(
  secret: string,
  payload: string,
  nonce: string | undefined,
  timestamp: string | undefined,
  signature: string | undefined,
): boolean {
  if (!nonce || !timestamp || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(nonce + timestamp + payload).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
