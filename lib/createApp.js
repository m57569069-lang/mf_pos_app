const path = require("path");
const express = require("express");
const cors = require("cors");
const { buildAnalyticsForecast, regressionFromRequest, parseForecastYear } = require("./salesForecast");
const { buildOverview } = require("./dashboard");
const { recordSale } = require("./sales");
const { parseCatalogProduct } = require("./products");

function createApp(store) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((error) => {
      console.error(error);
      res.status(error.status || 500).json({ error: error.message });
    });

  const api = express.Router();
  api.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  function crud(routePath, table, listKey, opts = {}) {
    api.get(
      `/${routePath}`,
      wrap(async (req, res) => {
        res.json({ [listKey]: await store.list(table) });
      })
    );
    api.post(
      `/${routePath}`,
      wrap(async (req, res) => {
        const data = { ...req.body };
        if (data.id == null || data.id === "") {
          data.id = opts.genId ? opts.genId() : Date.now();
        }
        await store.upsert(table, data.id, data);
        res.json(data);
      })
    );
    if (opts.del) {
      api.delete(
        `/${routePath}/:id`,
        wrap(async (req, res) => {
          await store.remove(table, req.params.id);
          if (table === "users") await store.releaseSession(req.params.id, { force: true });
          res.json({ ok: true });
        })
      );
    }
  }

  crud("products", "products", "products");

  api.post(
    "/products/bulk",
    wrap(async (req, res) => {
      const list = Array.isArray(req.body.products) ? req.body.products : [];
      await store.transaction(async (tx) => {
        for (const product of list) {
          if (product.id == null) continue;
          await tx.insertIfAbsent("products", product.id, product);
        }
      });
      res.json({ products: await store.list("products") });
    })
  );

  api.put(
    "/products/:id",
    wrap(async (req, res) => {
      const old = (await store.get("products", req.params.id)) || {};
      const data = { ...req.body, id: req.body.id ?? old.id ?? req.params.id };
      for (const key of ["stock", "sold", "damaged"]) {
        if (old[key] !== undefined) data[key] = old[key];
      }
      await store.upsert("products", req.params.id, data);
      res.json(data);
    })
  );

  api.post(
    "/products/:id/stock-adjust",
    wrap(async (req, res) => {
      const stockDelta = Number(req.body.stockDelta || 0);
      const soldDelta = Number(req.body.soldDelta || 0);
      const damagedDelta = Number(req.body.damagedDelta || 0);
      const updated = await store.transaction(async (tx) => {
        const product = await tx.get("products", req.params.id, { lock: true });
        if (!product) {
          const error = new Error("Product not found");
          error.status = 404;
          throw error;
        }
        product.stock = Math.max(0, (Number(product.stock) || 0) + stockDelta);
        product.sold = Math.max(0, (Number(product.sold) || 0) + soldDelta);
        product.damaged = Math.max(0, (Number(product.damaged) || 0) + damagedDelta);
        await tx.upsert("products", req.params.id, product);
        return product;
      });
      res.json(updated);
    })
  );

  crud("suppliers", "suppliers", "suppliers", { del: true });
  crud("job-orders", "job_orders", "jobOrders");
  crud("tool-requests", "tool_requests", "toolRequests");
  crud("supplier-returns", "supplier_returns", "supplierReturns");
  crud("warranties", "warranties", "warranties");
  crud("warranty-claims", "warranty_claims", "warrantyClaims");
  crud("transactions", "transactions", "transactions", { genId: () => "TXN-" + Date.now() });
  crud("purchase-orders", "purchase_orders", "purchaseOrders", { genId: () => "PO-" + Date.now() });

  api.post(
    "/purchase-orders/:id/receive",
    wrap(async (req, res) => {
      const po = await store.get("purchase_orders", req.params.id);
      if (!po) return res.status(404).json({ error: "Purchase order not found" });
      const received = req.body.receivedQtyByItemIndex || {};
      const items = Array.isArray(po.items) ? po.items : [];
      for (const [idx, qty] of Object.entries(received)) {
        const index = Number(idx);
        if (items[index]) items[index].receivedQty = (Number(items[index].receivedQty) || 0) + Number(qty);
      }
      po.items = items;
      po.status = "received";
      po.receivedAt = new Date().toISOString();
      await store.upsert("purchase_orders", req.params.id, po);
      res.json(po);
    })
  );

  crud("users", "users", "users", { del: true });

  api.post(
    "/users/:id/session",
    wrap(async (req, res) => {
      const { token, expiresAt, lastLogin } = req.body;
      const user = await store.get("users", req.params.id);
      if (!user) return res.status(404).json({ error: "User not found" });
      const claimed = await store.claimSession(req.params.id, token, expiresAt);
      if (!claimed) {
        return res.status(409).json({ error: "This account is already signed in on another device." });
      }
      if (lastLogin) user.lastLogin = lastLogin;
      await store.upsert("users", req.params.id, user);
      res.json(user);
    })
  );

  api.delete(
    "/users/:id/session",
    wrap(async (req, res) => {
      await store.releaseSession(req.params.id, {
        token: String(req.query.token || ""),
        force: req.query.force === "true",
      });
      res.json({ ok: true });
    })
  );

  api.post(
    "/catalog",
    wrap(async (req, res) => {
      const parsed = parseCatalogProduct(req.body, null);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      await store.upsert("products", parsed.product.id, parsed.product);
      res.status(201).json(parsed.product);
    })
  );

  api.put(
    "/catalog/:id",
    wrap(async (req, res) => {
      const existing = await store.get("products", req.params.id);
      if (!existing) return res.status(404).json({ error: "Product not found" });
      const parsed = parseCatalogProduct(req.body, existing);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      parsed.product.id = existing.id;
      await store.upsert("products", req.params.id, parsed.product);
      res.json(parsed.product);
    })
  );

  api.post(
    "/sales",
    wrap(async (req, res) => {
      const result = await recordSale(store, req.body);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.status(result.status).json(result.sale);
    })
  );

  api.get(
    "/analytics/forecast",
    wrap(async (req, res) => {
      const year = parseForecastYear(req.query.year);
      if (year === null) {
        return res.status(400).json({ error: "year must be an integer from 2000 to 2100." });
      }
      const forecast = buildAnalyticsForecast({
        products: await store.list("products"),
        transactions: await store.list("transactions"),
        purchaseOrders: await store.list("purchase_orders"),
        year,
        productId: req.query.productId,
      });
      if (forecast.productNotFound) return res.status(404).json({ error: "Product not found" });
      delete forecast.productNotFound;
      res.json(forecast);
    })
  );

  api.get(
    "/analytics/overview",
    wrap(async (req, res) => {
      const year = parseForecastYear(req.query.year);
      if (year === null) {
        return res.status(400).json({ error: "year must be an integer from 2000 to 2100." });
      }
      const overview = buildOverview({
        products: await store.list("products"),
        transactions: await store.list("transactions"),
        purchaseOrders: await store.list("purchase_orders"),
        year,
      });
      delete overview.productNotFound;
      res.json(overview);
    })
  );

  api.post(
    "/analytics/linear-regression",
    wrap(async (req, res) => {
      const result = regressionFromRequest(req.body);
      if (result.error) return res.status(400).json({ error: result.error });
      res.json(result);
    })
  );

  app.get(["/api", "/health", "/api/health"], (req, res) => {
    res.json({ status: "ok", service: "mf_pos_app api" });
  });
  app.use("/api", api);
  app.use("/", api);
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use((req, res) => res.status(404).json({ error: "Not found: " + req.method + " " + req.path }));
  return app;
}

module.exports = {
  createApp,
};
