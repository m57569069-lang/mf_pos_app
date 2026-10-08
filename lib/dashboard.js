const { buildAnalyticsForecast, isBulkSale, isValidSale } = require("./salesForecast");

function buildOverview(input = {}) {
  const forecast = buildAnalyticsForecast(input);
  const year = forecast.year;
  const now = input.now instanceof Date && !Number.isNaN(input.now.getTime()) ? input.now : new Date();
  const products = Array.isArray(input.products) ? input.products : [];
  const transactions = (Array.isArray(input.transactions) ? input.transactions : []).filter(isValidSale);

  const today = dateKey(now);
  const month = now.getUTCMonth() + 1;
  const kpis = {
    todayRevenue: 0,
    todayUnits: 0,
    todayTickets: 0,
    monthRevenue: 0,
    monthUnits: 0,
    yearRevenue: 0,
    productCount: products.filter((product) => product && product.id != null).length,
    inventoryCost: 0,
    inventoryRetail: 0,
  };

  for (const product of products) {
    if (!product) continue;
    const stock = nonNegative(product.stock);
    kpis.inventoryCost = roundMoney(kpis.inventoryCost + stock * nonNegative(product.cost));
    kpis.inventoryRetail = roundMoney(kpis.inventoryRetail + stock * nonNegative(product.price));
  }

  const totals = new Map();
  for (const product of products) {
    if (!product || product.id == null || product.id === "") continue;
    totals.set(String(product.id), {
      id: product.id,
      name: product.name || `Product ${product.id}`,
      category: product.category || "Uncategorized",
      units: 0,
      revenue: 0,
    });
  }

  for (const transaction of transactions) {
    const stamp = new Date(transaction.date ?? transaction.createdAt ?? transaction.created_at);
    if (Number.isNaN(stamp.getTime())) continue;
    const units = (transaction.items || []).reduce((sum, item) => sum + itemQty(item), 0);
    const total = Number(transaction.total) || 0;
    if (stamp.getUTCFullYear() === now.getUTCFullYear() && stamp.getUTCMonth() + 1 === month) {
      kpis.monthRevenue = roundMoney(kpis.monthRevenue + total);
      kpis.monthUnits += units;
    }
    if (dateKey(stamp) === today) {
      kpis.todayRevenue = roundMoney(kpis.todayRevenue + total);
      kpis.todayUnits += units;
      kpis.todayTickets += 1;
    }
    if (stamp.getUTCFullYear() === year) {
      kpis.yearRevenue = roundMoney(kpis.yearRevenue + total);
    }
    if (isBulkSale(transaction) || stamp.getUTCFullYear() !== year) continue;
    for (const item of transaction.items || []) {
      const bucket = totals.get(String(itemProductId(item)));
      const qty = itemQty(item);
      if (!bucket || qty <= 0) continue;
      bucket.units += qty;
      const price = Number(item.price);
      const line = Number.isFinite(price) ? price * qty : 0;
      bucket.revenue = roundMoney(bucket.revenue + line);
    }
  }

  const ranked = [...totals.values()].filter((product) => product.units > 0 || product.revenue > 0);
  const unitSum = ranked.reduce((sum, product) => sum + product.units, 0);
  const revenueSum = ranked.reduce((sum, product) => sum + product.revenue, 0);
  for (const product of ranked) {
    product.unitShare = unitSum === 0 ? 0 : product.units / unitSum;
    product.revenueShare = revenueSum === 0 ? 0 : product.revenue / revenueSum;
  }
  ranked.sort((a, b) => b.revenue - a.revenue || b.units - a.units || String(a.name).localeCompare(String(b.name)));

  const byId = new Map(forecast.products.map((product) => [String(product.id), product]));
  const lowStock = products
    .filter((product) => product && product.id != null)
    .map((product) => {
      const stock = nonNegative(product.stock);
      const reorder = nonNegative(product.reorder ?? product.reorderLevel);
      const forecasted = byId.get(String(product.id));
      return {
        id: product.id,
        name: product.name || `Product ${product.id}`,
        category: product.category || "Uncategorized",
        stock,
        reorder,
        deficit: reorder - stock,
        recommendation: forecasted ? forecasted.inventoryRecommendation : null,
      };
    })
    .filter((product) => product.reorder > 0 && product.stock <= product.reorder)
    .sort((a, b) => b.deficit - a.deficit || String(a.name).localeCompare(String(b.name)));

  kpis.lowStockCount = lowStock.length;
  const next = forecast.revenue.series.find((point) => point.month === forecast.lastActualMonth + 1);
  kpis.nextMonthLabel = next ? next.label : null;
  kpis.nextMonthForecast = next ? next.value : null;

  const { productNotFound, ...publicForecast } = forecast;
  return {
    method: "linear_regression",
    objective: "minimize_mean_squared_error",
    year,
    asOf: forecast.asOf,
    lastActualMonth: forecast.lastActualMonth,
    kpis,
    lowStock,
    topProducts: ranked,
    forecast: publicForecast,
    productNotFound,
  };
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function itemProductId(item) {
  if (!item) return null;
  if (item.productId != null && item.productId !== "") return item.productId;
  return item.product_id;
}

function itemQty(item) {
  const qty = Number(item && (item.qty ?? item.quantity));
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function nonNegative(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  buildOverview,
};
