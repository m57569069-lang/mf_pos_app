const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(require("cors")());
app.use((req, res, next) => {
  if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
  next();
});
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("railway.internal")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      total NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id),
      product_id INTEGER REFERENCES products(id),
      quantity INTEGER NOT NULL,
      price NUMERIC(10,2) NOT NULL
    );
  `);
}

app.get("/", (req, res) => res.send("mf_pos_app is running"));

app.get("/products", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM products ORDER BY id");
    res.json({ products: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/products", async (req, res) => {
  const { name, price, stock } = req.body;
  if (!name || price == null) return res.status(400).json({ error: "name and price required" });
  try {
    const r = await pool.query(
      "INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *",
      [name, price, stock || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/sales", async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items required" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let total = 0;
    const lines = [];
    for (const it of items) {
      const p = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [it.product_id]);
      if (p.rows.length === 0) throw new Error("Product not found: " + it.product_id);
      if (p.rows[0].stock < it.quantity) throw new Error("Not enough stock: " + p.rows[0].name);
      total += Number(p.rows[0].price) * it.quantity;
      lines.push({ id: it.product_id, qty: it.quantity, price: p.rows[0].price });
    }
    const s = await client.query("INSERT INTO sales (total) VALUES ($1) RETURNING *", [total]);
    for (const l of lines) {
      await client.query(
        "INSERT INTO sale_items (sale_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)",
        [s.rows[0].id, l.id, l.qty, l.price]
      );
      await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [l.qty, l.id]);
    }
    await client.query("COMMIT");
    res.status(201).json(s.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

initDb()
  .then(() => app.listen(PORT, "0.0.0.0", () => console.log("Listening on port " + PORT)))
  .catch((e) => { console.error("DB init failed", e); process.exit(1); });

