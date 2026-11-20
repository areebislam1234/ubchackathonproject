// Pixel-art odds charts: a market's YES price (= the market's implied chance) over time.
// Points come from /api/odds/:market as [time ms, mid bps]. Drawn as a crisp step line in SVG.
import { esc } from "./ui.js";

const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A full chart with a 0-100¢ scale, gridlines at 25/50/75 and the latest value called out. */
export function oddsChart(series, { height = 150, label = "" } = {}) {
  const pts = series?.points ?? [];
  if (pts.length < 2) {
    const since = series?.since ? ` since ${clock(series.since)}` : "";
    return `<div class="ochart empty"><p class="note">Recording this market's odds${since}. The chart fills in as Gemini's prices come in (Gemini's API gives live prices, so Fortune Front keeps the history itself).</p></div>`;
  }
  const W = 480;
  const H = height;
  const L = 34; // room for the 0-100 labels
  const R = 8;
  const T = 8;
  const B = 18;
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const x = (t) => Math.round(L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R));
  const y = (bps) => Math.round(T + (1 - bps / 10000) * (H - T - B));
  // step path: hold each value until the next point
  let d = `M${x(pts[0][0])},${y(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `H${x(pts[i][0])}V${y(pts[i][1])}`;
  const area = `${d}V${y(0)}H${x(pts[0][0])}Z`;
  const grid = [0, 2500, 5000, 7500, 10000]
    .map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="og-grid${v === 5000 ? " mid" : ""}"/><text x="${L - 4}" y="${y(v) + 4}" class="og-lab" text-anchor="end">${v / 100}¢</text>`)
    .join("");
  const last = pts[pts.length - 1];
  const up = (series.changeBps ?? 0) >= 0;
  const ticks = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text x="${x(t)}" y="${H - 4}" class="og-lab" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">${clock(t)}</text>`).join("");
  return `<figure class="ochart"><svg viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" role="img" aria-label="${esc(label || "Odds over time")}: now ${Math.round(last[1] / 100)} cents">
    ${grid}
    <path d="${area}" class="og-area ${up ? "up" : "down"}"/>
    <path d="${d}" class="og-line ${up ? "up" : "down"}" fill="none"/>
    <rect x="${x(last[0]) - 4}" y="${y(last[1]) - 4}" width="8" height="8" class="og-dot ${up ? "up" : "down"}"/>
    ${ticks}
  </svg></figure>`;
}

/** A small inline sparkline from a list of bps values. */
export function sparkline(values, { w = 96, h = 26 } = {}) {
  const v = (values ?? []).filter((n) => n !== null && n !== undefined);
  if (v.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = Math.max(200, hi - lo); // at least 2¢ of range so flat lines stay flat
  const mid = (lo + hi) / 2;
  const y = (n) => Math.round(h - 3 - ((n - (mid - span / 2)) / span) * (h - 6));
  let d = `M0,${y(v[0])}`;
  v.forEach((n, i) => i && (d += `H${Math.round((i / (v.length - 1)) * w)}V${y(n)}`));
  const up = v[v.length - 1] >= v[0];
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true"><path d="${d}" class="og-line ${up ? "up" : "down"}" fill="none"/></svg>`;
}

/** "+7¢" / "−3¢" with a colour class. */
export function changeTag(bps) {
  if (bps === null || bps === undefined) return `<span class="chg">–</span>`;
  const c = Math.round(bps / 100);
  return `<span class="chg ${c > 0 ? "up" : c < 0 ? "down" : ""}">${c > 0 ? "▲ +" : c < 0 ? "▼ −" : ""}${Math.abs(c)}¢</span>`;
}

/** Plain English for a YES price: what the market thinks, and what a 100-gold YES ticket pays. */
export function plainOdds(bps) {
  if (bps === null || bps === undefined) return "No price right now.";
  const c = Math.round(bps / 100);
  const lean = c >= 80 ? "very likely" : c >= 60 ? "likely" : c > 40 ? "a coin flip, roughly" : c > 20 ? "unlikely" : "very unlikely";
  return `YES trades at ${c}¢, so the market puts this at about a ${c}% chance (${lean}). A YES ticket that costs ${c} pays 100 if it happens.`;
}
