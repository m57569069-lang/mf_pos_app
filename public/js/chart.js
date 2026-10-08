import { escapeHtml } from "./format.js";

export function trendChart(series, options = {}) {
  const width = 320;
  const height = options.compact ? 128 : 176;
  const padL = 6;
  const padR = 6;
  const padT = 14;
  const padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const points = Array.isArray(series) ? series : [];
  const slot = innerW / Math.max(points.length, 1);
  let max = 1;
  for (const point of points) {
    if (point.actual != null) max = Math.max(max, point.actual);
    if (point.predicted != null) max = Math.max(max, Math.max(0, point.predicted));
  }

  const x = (index) => padL + slot * index + slot / 2;
  const y = (value) => padT + innerH - (Math.max(0, value) / max) * innerH;
  const bars = [];
  const past = [];
  const future = [];

  points.forEach((point, index) => {
    if (point.isActual && point.actual > 0) {
      const barW = Math.min(16, slot * 0.52);
      const top = y(point.actual);
      const barH = padT + innerH - top;
      bars.push(
        `<rect x="${(x(index) - barW / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(barH, 1).toFixed(2)}" rx="3" class="bar"><title>${escapeHtml(point.label)} recorded ${escapeHtml(point.actual)}</title></rect>`
      );
    }
    if (point.predicted == null || !Number.isFinite(point.predicted)) return;
    const coord = `${x(index).toFixed(2)},${y(point.predicted).toFixed(2)}`;
    if (point.isActual) past.push(coord);
    else future.push(coord);
  });
  if (past.length && future.length) future.unshift(past[past.length - 1]);

  const labels = points
    .map((point, index) => {
      if (options.compact && index % 2 === 1) return "";
      return `<text x="${x(index).toFixed(2)}" y="${height - 6}" text-anchor="middle" class="tick">${escapeHtml(point.label)}</text>`;
    })
    .join("");

  const dots = points
    .map((point, index) => {
      if (point.isActual || point.predicted == null) return "";
      return `<circle cx="${x(index).toFixed(2)}" cy="${y(Math.max(0, point.predicted)).toFixed(2)}" r="2.6" class="dot"><title>${escapeHtml(point.label)} forecast ${escapeHtml(point.value)}</title></circle>`;
    })
    .join("");

  const line = (coords, cls) =>
    coords.length >= 2 ? `<polyline points="${coords.join(" ")}" class="${cls}"></polyline>` : "";

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.label || "Sales trend")}">
    <line x1="${padL}" y1="${(padT + innerH).toFixed(2)}" x2="${width - padR}" y2="${(padT + innerH).toFixed(2)}" class="axis"></line>
    ${bars.join("")}
    ${line(past, "fit")}
    ${line(future, "forecast")}
    ${dots}
    ${labels}
  </svg>`;
}
