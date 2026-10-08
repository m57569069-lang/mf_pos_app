const UNIT_PLAN = {
  1: [12, 14, 13, 16, 18, 17, 20, 22, 21, 24, 26, 28],
  2: [14, 15, 16, 15, 17, 16, 18, 18, 19, 20, 20, 21],
  3: [6, 7, 6, 8, 9, 8, 10, 11, 10, 12, 13, 14],
  4: [4, 5, 4, 6, 6, 5, 7, 7, 8, 8, 9, 9],
  5: [22, 24, 20, 26, 28, 24, 30, 32, 28, 34, 36, 38],
  6: [8, 6, 7, 5, 4, 4, 3, 3, 2, 2, 2, 1],
  7: [3, 3, 4, 4, 5, 4, 5, 6, 5, 6, 6, 7],
  8: [7, 6, 5, 5, 4, 3, 3, 2, 2, 1, 1, 1],
};

function productCatalog() {
  return [
    { id: 1, name: "Kingston Fury 16GB", category: "Memory", sku: "RAM-16", price: 2450, cost: 1800, stock: 14, reorder: 8 },
    { id: 2, name: "Quiet Click Mouse", category: "Peripherals", sku: "MSE-02", price: 450, cost: 210, stock: 40, reorder: 10 },
    { id: 3, name: "NVMe SSD 1TB", category: "Storage", sku: "SSD-1T", price: 3890, cost: 2900, stock: 9, reorder: 6 },
    { id: 4, name: "Tactile Keyboard", category: "Peripherals", sku: "KBD-04", price: 1890, cost: 1100, stock: 11, reorder: 4 },
    { id: 5, name: "USB-C Cable 1m", category: "Cables", sku: "CBL-C1", price: 199, cost: 60, stock: 80, reorder: 20 },
    { id: 6, name: "HDMI 2.1 Cable", category: "Cables", sku: "CBL-H2", price: 349, cost: 120, stock: 3, reorder: 12 },
    { id: 7, name: "Aluminum Laptop Stand", category: "Accessories", sku: "STD-07", price: 890, cost: 420, stock: 7, reorder: 4 },
    { id: 8, name: "1080p Webcam", category: "Video", sku: "CAM-08", price: 1590, cost: 900, stock: 2, reorder: 5 },
  ];
}

function buildSeed(now = new Date()) {
  const year = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const today = now.getUTCDate();
  const products = productCatalog();
  const sold = Object.fromEntries(products.map((product) => [product.id, 0]));
  const transactions = [];

  for (let month = 1; month <= Math.min(12, currentMonth); month++) {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const limit = month === currentMonth ? Math.min(daysInMonth, today) : daysInMonth;
    if (limit < 1) continue;
    for (const product of products) {
      const qty = UNIT_PLAN[product.id][month - 1];
      if (!qty) continue;
      const day = Math.min(limit, 3 + (product.id % 5));
      sold[product.id] += qty;
      const sequence = transactions.length + 1;
      transactions.push({
        id: `TXN-SEED-${year}${String(month).padStart(2, "0")}-${product.id}`,
        date: new Date(Date.UTC(year, month - 1, day, 2, 0, sequence)).toISOString(),
        total: roundMoney(product.price * qty),
        payment: "Cash",
        buyerName: "Walk-in",
        status: "paid",
        items: [{ productId: product.id, name: product.name, qty, price: product.price }],
      });
    }
  }

  const todayKey = now.toISOString().slice(0, 10);
  const hasToday = transactions.some((transaction) => transaction.date.slice(0, 10) === todayKey);
  if (!hasToday) {
    const mouse = products.find((product) => product.id === 2);
    const cable = products.find((product) => product.id === 5);
    sold[mouse.id] += 1;
    sold[cable.id] += 2;
    transactions.push({
      id: "TXN-SEED-TODAY",
      date: new Date(Date.UTC(year, currentMonth - 1, today, 6, 15, 0)).toISOString(),
      total: roundMoney(mouse.price + cable.price * 2),
      payment: "GCash",
      buyerName: "Walk-in",
      status: "paid",
      items: [
        { productId: mouse.id, name: mouse.name, qty: 1, price: mouse.price },
        { productId: cable.id, name: cable.name, qty: 2, price: cable.price },
      ],
    });
  }

  for (const product of products) {
    product.sold = sold[product.id];
    product.damaged = 0;
  }
  return { products, transactions };
}

async function seedIfEmpty(store, now = new Date()) {
  const [products, transactions] = await Promise.all([
    store.list("products"),
    store.list("transactions"),
  ]);
  if (products.length > 0 || transactions.length > 0) return false;
  const seed = buildSeed(now);
  await store.transaction(async (tx) => {
    for (const product of seed.products) await tx.upsert("products", product.id, product);
    for (const transaction of seed.transactions) {
      await tx.upsert("transactions", transaction.id, transaction);
    }
  });
  return true;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  buildSeed,
  seedIfEmpty,
  productCatalog,
};
