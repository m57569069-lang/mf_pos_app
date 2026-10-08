export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

export function money(value) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : 0;
  const digits = Math.abs(safe - Math.round(safe)) < 0.001 ? 0 : 2;
  const formatted = new Intl.NumberFormat("en-PH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(safe);
  return "₱" + formatted;
}

export function units(value) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : 0;
  const digits = Math.abs(safe - Math.round(safe)) < 0.05 ? 0 : 1;
  return new Intl.NumberFormat("en-PH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(safe);
}

export function dayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function perMonth(slope, asMoney) {
  const number = Number(slope) || 0;
  const body = asMoney ? money(Math.abs(number)) : units(Math.abs(number));
  if (Math.abs(number) < (asMoney ? 1 : 0.05)) return "Flat across the recorded months";
  return (number > 0 ? "Up " : "Down ") + body + " each month";
}

export function titleWord(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
