const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createFileStore } = require("../lib/store");
const { createApp } = require("../lib/createApp");
const { buildSeed, seedIfEmpty } = require("../lib/seed");
const { buildOverview } = require("../lib/dashboard");
const { recordSale } = require("../lib/sales");

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "counter-")), "store.json");
}

test("sample shop ranks Kingston by revenue and cables by units", () => {
  const now = new Date("2026-10-08T12:00:00.000Z");
  const seed = buildSeed(now);
  const overview = buildOverview({ ...seed, purchaseOrders: [], now });

  assert.equal(overview.method, "linear_regression");
  assert.equal(overview.topProducts[0].name, "Kingston Fury 16GB");
  const byUnits = overview.topProducts.slice().sort((a, b) => b.units - a.units);
  assert.equal(byUnits[0].name, "USB-C Cable 1m");
  assert.equal(overview.forecast.revenue.model.trend, "rising");
  assert.ok(overview.forecast.revenue.model.rSquared > 0.3);
  assert.equal(overview.forecast.products.find((product) => product.id === 8).model.trend, "falling");
  assert.equal(overview.kpis.todayRevenue, 848);
  assert.ok(overview.lowStock.some((product) => product.name === "1080p Webcam"));
  assert.ok(overview.lowStock.some((product) => product.name === "HDMI 2.1 Cable"));
  assert.equal(overview.kpis.nextMonthLabel, "Nov");
  assert.ok(overview.kpis.nextMonthForecast > 0);
});

test("a sale decrements stock once and rolls back when another line fails", async () => {
  const store = createFileStore(tempFile());
  await store.init();
  await store.upsert("products", 1, { id: 1, name: "Mouse", price: 100, stock: 2, sold: 0 });
  await store.upsert("products", 2, { id: 2, name: "Cable", price: 50, stock: 1, sold: 0 });

  const denied = await recordSale(store, {
    items: [
      { productId: 1, qty: 2 },
      { productId: 2, qty: 2 },
    ],
  });
  assert.equal(denied.status, 409);
  assert.equal((await store.get("products", 1)).stock, 2);

  const sold = await recordSale(store, { items: [{ productId: 1, qty: 1 }], payment: "Card" });
  assert.equal(sold.status, 201);
  assert.equal(sold.sale.total, 100);
  assert.equal(sold.sale.payment, "Card");
  assert.equal((await store.get("products", 1)).stock, 1);
  assert.equal((await store.get("products", 1)).sold, 1);
  assert.equal((await store.list("transactions")).length, 1);

  const again = await recordSale(store, { items: [{ productId: 1, qty: 0 }] });
  assert.equal(again.status, 400);
});

test("one live session per user on the file store", async () => {
  const store = createFileStore(tempFile());
  await store.init();
  await store.upsert("users", "u1", { id: "u1", name: "Ana" });
  const soon = new Date(Date.now() + 60_000).toISOString();
  const expired = new Date(Date.now() - 1000).toISOString();
  assert.equal(await store.claimSession("u1", "token-a", soon), true);
  assert.equal(await store.claimSession("u1", "token-b", soon), false);
  assert.equal(await store.claimSession("u1", "token-a", soon), true);
  await store.releaseSession("u1", { token: "nope" });
  assert.equal(await store.claimSession("u1", "token-b", soon), false);
  await store.releaseSession("u1", { token: "token-a" });
  assert.equal(await store.claimSession("u1", "token-b", expired), true);
  assert.equal(await store.claimSession("u1", "token-c", soon), true);
});

test("seed runs once and the mobile API serves the counter", async () => {
  const store = createFileStore(tempFile());
  await store.init();
  const now = new Date("2026-10-08T12:00:00.000Z");
  assert.equal(await seedIfEmpty(store, now), true);
  assert.equal(await seedIfEmpty(store, now), false);

  const app = createApp(store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const home = await fetch(base + "/");
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /Counter/);
    assert.match(html, /\/js\/app\.js/);

    const style = await fetch(base + "/css/app.css");
    assert.equal(style.status, 200);

    const health = await fetch(base + "/api/health");
    assert.equal((await health.json()).status, "ok");

    const overview = await fetch(base + "/api/analytics/overview?year=2026");
    const body = await overview.json();
    assert.equal(overview.status, 200);
    assert.equal(body.topProducts[0].name, "Kingston Fury 16GB");
    assert.equal(body.forecast.method, "linear_regression");

    const rootProducts = await fetch(base + "/products");
    assert.equal(rootProducts.status, 200);
    assert.equal((await rootProducts.json()).products.length, 8);

    const before = body.kpis.todayRevenue;
    const sale = await fetch(base + "/api/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ productId: 2, qty: 1 }], payment: "Cash" }),
    });
    const ticket = await sale.json();
    assert.equal(sale.status, 201);
    assert.equal(ticket.total, 450);

    const after = await (await fetch(base + "/api/analytics/overview?year=2026")).json();
    assert.equal(after.kpis.todayRevenue, Math.round((before + 450) * 100) / 100);
    const mouse = after.forecast.products.find((product) => product.id === 2);
    assert.equal(mouse.currentStock, 39);

    const tooMany = await fetch(base + "/api/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ productId: 8, qty: 9 }] }),
    });
    assert.equal(tooMany.status, 409);

    const created = await fetch(base + "/api/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Desk Mat", price: 300, stock: 4, reorder: 1 }),
    });
    assert.equal(created.status, 201);
    const mat = await created.json();
    assert.equal(mat.stock, 4);

    const renamed = await fetch(base + "/api/catalog/" + mat.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Large Desk Mat", price: 320, stock: 99 }),
    });
    const saved = await renamed.json();
    assert.equal(renamed.status, 200);
    assert.equal(saved.name, "Large Desk Mat");
    assert.equal(saved.stock, 4);

    const blank = await fetch(base + "/api/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price: 10 }),
    });
    assert.equal(blank.status, 400);

    const line = await fetch(base + "/api/analytics/linear-regression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthlyValues: [1, 2, 3], lastActualMonth: 3 }),
    });
    const learned = await line.json();
    assert.equal(line.status, 200);
    assert.equal(learned.method, "linear_regression");
    assert.ok(Math.abs(learned.model.slope - 1) < 1e-9);

    const user = await fetch(base + "/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "ana", name: "Ana" }),
    });
    assert.equal(user.status, 200);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = await fetch(base + "/api/users/ana/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "device-a", expiresAt }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(base + "/api/users/ana/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "device-b", expiresAt }),
    });
    assert.equal(second.status, 409);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
