// Small UI helpers: sheets, toasts, formatting.
import { sfx } from "./audio.js";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
export const cents = (bps) => (bps === null || bps === undefined ? "–" : `${Math.round(bps / 100)}¢`);
export const pct = (bps) => (bps === null || bps === undefined ? "–" : `${Math.round(bps / 100)}%`);
export function timeLeft(ms) {
  if (ms <= 0) return "0:00";
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${ss}`;
}
export function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

export function toast(text, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  $("toasts").append(t);
  setTimeout(() => t.remove(), 4200);
  if (kind === "bad") sfx("error");
}

let sheetKind = null;
let onSheetClose = null;
export function openSheet(kind, html, { onClose } = {}) {
  const wasOpen = !$("sheet").hidden;
  sheetKind = kind;
  onSheetClose = onClose ?? null;
  $("sheet-body").innerHTML = html;
  $("sheet").hidden = false;
  if (!wasOpen) sfx("open");
  return $("sheet-body");
}
export function closeSheet() {
  if ($("sheet").hidden) return;
  $("sheet").hidden = true;
  sheetKind = null;
  sfx("close");
  const fn = onSheetClose;
  onSheetClose = null;
  fn?.();
}
export const currentSheet = () => sheetKind;

/** Run an async action from a button: disables it, reports errors as toasts. */
export async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, "bad");
    return null;
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}
