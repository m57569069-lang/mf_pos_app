const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("railway.internal")
      ? { rejectUnauthorized: false }
      : false,
});

// Each entity is stored as a JSON document keyed by id, so the server
// accepts whatever fields the Flutter models send.
const TABLES = [
  "products",
  "suppliers",
  "users",
  "purchase_orders",
  "transactions",
  "job_orders",
  "tool_requests",
  "supplier_returns",
  "warranties",
  "warranty_claims",
];

async function initDb() {
  for (const t of TABLES) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS app_${t} (
        seq BIGSERIAL,
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`
    );
  }
  await pool.query(
    `CREATE TABLE IF NOT EXISTS app_user_sessions (
      user_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`
  );
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message });
  });

async function listAll(table) {
  const r = await pool.query(`SELECT data FROM app_${table} ORDER BY seq`);
  return r.rows.map((x) => x.data);
}

async function upsert(db, table, id, data) {
  await db.query(
    `INSERT INTO app_${table} (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [String(id), data]
  );
  return data;
}

const api = express.Router();

api.get("/", (req, res) => res.json({ status: "ok", service: "mf_pos_app api" }));
api.get("/health", (req, res) => res.json({ status: "ok" }));

// Generic list + upsert (+ optional delete) for an entity.
function crud(path, table, listKey, opts = {}) {
  api.get(
    `/${path}`,
    wrap(async (req, res) => {
      res.json({ [listKey]: await listAll(table) });
    })
  );
  api.post(
    `/${path}`,
    wrap(async (req, res) => {
      const data = { ...req.body };
      if (data.id == null || data.id === "") {
        data.id = opts.genId ? opts.genId() : Date.now();
      }
      await upsert(pool, table, data.id, data);
      res.json(data);
    })
  );
  if (opts.del) {
    api.delete(
      `/${path}/:id`,
      wrap(async (req, res) => {
        await pool.query(`DELETE FROM app_${table} WHERE id = $1`, [req.params.id]);
        if (table === "users") {
          await pool.query("DELETE FROM app_user_sessions WHERE user_id = $1", [req.params.id]);
        }
        res.json({ ok: true });
      })
    );
  }
}

// ---------------------------------------------------------------- Products
crud("products", "products", "products");

api.post(
  "/products/bulk",
  wrap(async (req, res) => {
    const list = Array.isArray(req.body.products) ? req.body.products : [];
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (const p of list) {
        if (p.id == null) continue;
        // Never overwrite existing rows, so a seed push can't reset live stock.
        await c.query(
          "INSERT INTO app_products (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
          [String(p.id), p]
        );
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    res.json({ products: await listAll("products") });
  })
);

// Updates metadata only; keeps the server's stock / sold / damaged values.
api.put(
  "/products/:id",
  wrap(async (req, res) => {
    const r = await pool.query("SELECT data FROM app_products WHERE id = $1", [req.params.id]);
    const old = r.rows[0] ? r.rows[0].data : {};
    const data = { ...req.body, id: req.body.id ?? old.id ?? req.params.id };
    for (const k of ["stock", "sold", "damaged"]) {
      if (old[k] !== undefined) data[k] = old[k];
    }
    await upsert(pool, "products", req.params.id, data);
    res.json(data);
  })
);

// Atomic stock change, safe when several devices sell at once.
api.post(
  "/products/:id/stock-adjust",
  wrap(async (req, res) => {
    const stockDelta = Number(req.body.stockDelta || 0);
    const soldDelta = Number(req.body.soldDelta || 0);
    const damagedDelta = Number(req.body.damagedDelta || 0);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query("SELECT data FROM app_products WHERE id = $1 FOR UPDATE", [
        req.params.id,
      ]);
      if (!r.rows.length) {
        await c.query("ROLLBACK");
        return res.status(404).json({ error: "Product not found" });
      }
      const d = r.rows[0].data;
      d.stock = Math.max(0, (Number(d.stock) || 0) + stockDelta);
      d.sold = Math.max(0, (Number(d.sold) || 0) + soldDelta);
      d.damaged = Math.max(0, (Number(d.damaged) || 0) + damagedDelta);
      await upsert(c, "products", req.params.id, d);
      await c.query("COMMIT");
      res.json(d);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

// ------------------------------------------------------------ Simple entities
crud("suppliers", "suppliers", "suppliers", { del: true });
crud("job-orders", "job_orders", "jobOrders");
crud("tool-requests", "tool_requests", "toolRequests");
crud("supplier-returns", "supplier_returns", "supplierReturns");
crud("warranties", "warranties", "warranties");
crud("warranty-claims", "warranty_claims", "warrantyClaims");
crud("transactions", "transactions", "transactions", { genId: () => "TXN-" + Date.now() });

// --------------------------------------------------------- Purchase orders
crud("purchase-orders", "purchase_orders", "purchaseOrders", { genId: () => "PO-" + Date.now() });

api.post(
  "/purchase-orders/:id/receive",
  wrap(async (req, res) => {
    const r = await pool.query("SELECT data FROM app_purchase_orders WHERE id = $1", [
      req.params.id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: "Purchase order not found" });
    const po = r.rows[0].data;
    const received = req.body.receivedQtyByItemIndex || {};
    const items = Array.isArray(po.items) ? po.items : [];
    for (const [idx, qty] of Object.entries(received)) {
      const i = Number(idx);
      if (items[i]) items[i].receivedQty = (Number(items[i].receivedQty) || 0) + Number(qty);
    }
    po.items = items;
    po.status = "received";
    po.receivedAt = new Date().toISOString();
    await upsert(pool, "purchase_orders", req.params.id, po);
    res.json(po);
  })
);

// ------------------------------------------------------------------- Users
crud("users", "users", "users", { del: true });

// Allows one live session per user. Returns 409 if another device holds it.
api.post(
  "/users/:id/session",
  wrap(async (req, res) => {
    const { token, expiresAt, lastLogin } = req.body;
    const u = await pool.query("SELECT data FROM app_users WHERE id = $1", [req.params.id]);
    if (!u.rows.length) return res.status(404).json({ error: "User not found" });
    const claim = await pool.query(
      `INSERT INTO app_user_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
         WHERE app_user_sessions.expires_at < NOW()
            OR app_user_sessions.token = EXCLUDED.token
       RETURNING user_id`,
      [req.params.id, token, expiresAt]
    );
    if (!claim.rows.length) {
      return res
        .status(409)
        .json({ error: "This account is already signed in on another device." });
    }
    const data = u.rows[0].data;
    if (lastLogin) data.lastLogin = lastLogin;
    await upsert(pool, "users", req.params.id, data);
    res.json(data);
  })
);

api.delete(
  "/users/:id/session",
  wrap(async (req, res) => {
    if (req.query.force === "true") {
      await pool.query("DELETE FROM app_user_sessions WHERE user_id = $1", [req.params.id]);
    } else {
      await pool.query("DELETE FROM app_user_sessions WHERE user_id = $1 AND token = $2", [
        req.params.id,
        String(req.query.token || ""),
      ]);
    }
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ Mounting
app.get("/", (req, res) => res.send("mf_pos_app is running"));
app.use("/api", api);
app.use("/", api);

app.use((req, res) => res.status(404).json({ error: "Not found: " + req.method + " " + req.path }));

initDb()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log("Listening on port " + PORT)))
  .catch((e) => {
    console.error("DB init failed", e);
    process.exit(1);
  });