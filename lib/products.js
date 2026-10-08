function parseCatalogProduct(body, existing) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const creating = existing == null;
  const name = readText(body.name, existing && existing.name, 80);
  if (!name) return { error: "name is required." };

  const category = readText(body.category, (existing && existing.category) || "Uncategorized", 40);
  const sku = readText(body.sku, existing && existing.sku, 32) || "";
  const price = readMoney(blank(body.price), existing && existing.price, "price");
  if (price.error) return price;
  const cost = readMoney(
    blank(body.cost) == null ? (creating ? 0 : undefined) : blank(body.cost),
    existing && existing.cost,
    "cost"
  );
  if (cost.error) return cost;

  let stock = existing ? numberOrZero(existing.stock) : 0;
  let reorder = existing ? numberOrZero(existing.reorder ?? existing.reorderLevel) : 0;
  const stockInput = blank(body.stock);
  const reorderInput = blank(body.reorder);
  if (creating || stockInput != null) {
    const parsed = readCount(stockInput == null && creating ? 0 : stockInput, "stock");
    if (parsed.error) return parsed;
    if (creating) stock = parsed.value;
  }
  if (creating || reorderInput != null) {
    const parsed = readCount(reorderInput == null && creating ? 0 : reorderInput, "reorder");
    if (parsed.error) return parsed;
    reorder = parsed.value;
  }

  const product = {
    ...(existing || {}),
    id: existing ? existing.id : body.id != null && body.id !== "" ? body.id : Date.now(),
    name,
    category: category || "Uncategorized",
    sku,
    price: price.value,
    cost: cost.value,
    stock,
    reorder,
    sold: existing ? numberOrZero(existing.sold) : 0,
    damaged: existing ? numberOrZero(existing.damaged) : 0,
  };
  return { product };
}

function blank(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

function readText(value, fallback, max) {
  const source = value == null ? fallback : value;
  if (source == null) return "";
  const text = String(source).trim();
  if (text.length > max) return text.slice(0, max);
  return text;
}

function readMoney(value, fallback, label) {
  const source = value == null ? fallback : value;
  if (source == null || source === "") return { error: `${label} is required.` };
  const number = Number(source);
  if (!Number.isFinite(number) || number < 0 || number > 10000000) {
    return { error: `${label} must be a number from 0 to 10000000.` };
  }
  return { value: Math.round(number * 100) / 100 };
}

function readCount(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1000000) {
    return { error: `${label} must be a whole number from 0 to 1000000.` };
  }
  return { value: number };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

module.exports = {
  parseCatalogProduct,
};
