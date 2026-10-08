const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

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

function assertTable(table) {
  if (!TABLES.includes(table)) throw new Error("Unknown collection");
}

function createStore(options = {}) {
  if (process.env.DATABASE_URL && !options.file) return createPgStore(process.env.DATABASE_URL);
  const file = options.file || process.env.DATA_FILE || path.join(__dirname, "..", "data", "store.json");
  return createFileStore(file);
}

function createFileStore(file) {
  const empty = () => ({
    tables: Object.fromEntries(TABLES.map((table) => [table, []])),
    sessions: {},
    seq: Object.fromEntries(TABLES.map((table) => [table, 0])),
  });

  let state = empty();
  let tail = Promise.resolve();

  function lock(fn) {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function load() {
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const next = empty();
    for (const table of TABLES) {
      const rows = parsed.tables && parsed.tables[table];
      next.tables[table] = Array.isArray(rows) ? rows : [];
      const seq = parsed.seq && parsed.seq[table];
      next.seq[table] = Number.isFinite(seq)
        ? seq
        : next.tables[table].reduce((max, row) => Math.max(max, row.seq || 0), 0);
    }
    next.sessions = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
    state = next;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  function rows(table) {
    assertTable(table);
    return state.tables[table];
  }

  const tx = {
    list(table) {
      return rows(table)
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((row) => row.data);
    },
    get(table, id) {
      const row = rows(table).find((entry) => entry.id === String(id));
      return row ? row.data : null;
    },
    upsert(table, id, data) {
      const list = rows(table);
      const key = String(id);
      const existing = list.find((entry) => entry.id === key);
      if (existing) existing.data = data;
      else {
        state.seq[table] += 1;
        list.push({ seq: state.seq[table], id: key, data });
      }
      return data;
    },
    insertIfAbsent(table, id, data) {
      const list = rows(table);
      const key = String(id);
      if (list.some((entry) => entry.id === key)) return false;
      state.seq[table] += 1;
      list.push({ seq: state.seq[table], id: key, data });
      return true;
    },
    remove(table, id) {
      const list = rows(table);
      const index = list.findIndex((entry) => entry.id === String(id));
      if (index >= 0) list.splice(index, 1);
    },
    claimSession(userId, token, expiresAt) {
      const exp = new Date(expiresAt);
      if (Number.isNaN(exp.getTime())) {
        const error = new Error("expiresAt must be a date.");
        error.status = 400;
        throw error;
      }
      const key = String(userId);
      const existing = state.sessions[key];
      const expired = !existing || new Date(existing.expires_at).getTime() < Date.now();
      if (!expired && existing.token !== token) return false;
      state.sessions[key] = { token, expires_at: exp.toISOString() };
      return true;
    },
    releaseSession(userId, { token, force } = {}) {
      const key = String(userId);
      const existing = state.sessions[key];
      if (!existing) return;
      if (force || existing.token === String(token || "")) delete state.sessions[key];
    },
  };

  return {
    kind: "file",
    file,
    async init() {
      return lock(() => {
        load();
        persist();
      });
    },
    async list(table) {
      return lock(() => tx.list(table));
    },
    async get(table, id) {
      return lock(() => tx.get(table, id));
    },
    async upsert(table, id, data) {
      return lock(() => {
        const saved = tx.upsert(table, id, data);
        persist();
        return saved;
      });
    },
    async insertIfAbsent(table, id, data) {
      return lock(() => {
        const inserted = tx.insertIfAbsent(table, id, data);
        if (inserted) persist();
        return inserted;
      });
    },
    async remove(table, id) {
      return lock(() => {
        tx.remove(table, id);
        persist();
      });
    },
    async claimSession(userId, token, expiresAt) {
      return lock(() => {
        const claimed = tx.claimSession(userId, token, expiresAt);
        if (claimed) persist();
        return claimed;
      });
    },
    async releaseSession(userId, options) {
      return lock(() => {
        tx.releaseSession(userId, options);
        persist();
      });
    },
    async transaction(fn) {
      return lock(async () => {
        const snapshot = JSON.stringify(state);
        try {
          const result = await fn(tx);
          persist();
          return result;
        } catch (error) {
          state = JSON.parse(snapshot);
          throw error;
        }
      });
    },
  };
}

function createPgStore(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl:
      connectionString && !connectionString.includes("railway.internal")
        ? { rejectUnauthorized: false }
        : false,
  });

  function clientOps(db) {
    return {
      async list(table) {
        assertTable(table);
        const result = await db.query(`SELECT data FROM app_${table} ORDER BY seq`);
        return result.rows.map((row) => row.data);
      },
      async get(table, id, options = {}) {
        assertTable(table);
        const lock = options.lock ? " FOR UPDATE" : "";
        const result = await db.query(`SELECT data FROM app_${table} WHERE id = $1${lock}`, [
          String(id),
        ]);
        return result.rows[0] ? result.rows[0].data : null;
      },
      async upsert(table, id, data) {
        assertTable(table);
        await db.query(
          `INSERT INTO app_${table} (id, data) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
          [String(id), data]
        );
        return data;
      },
      async insertIfAbsent(table, id, data) {
        assertTable(table);
        const result = await db.query(
          `INSERT INTO app_${table} (id, data) VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [String(id), data]
        );
        return result.rows.length > 0;
      },
      async remove(table, id) {
        assertTable(table);
        await db.query(`DELETE FROM app_${table} WHERE id = $1`, [String(id)]);
      },
    };
  }

  const ops = clientOps(pool);

  return {
    kind: "postgres",
    async init() {
      for (const table of TABLES) {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS app_${table} (
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
    },
    list: (table) => ops.list(table),
    get: (table, id) => ops.get(table, id),
    upsert: (table, id, data) => ops.upsert(table, id, data),
    insertIfAbsent: (table, id, data) => ops.insertIfAbsent(table, id, data),
    remove: (table, id) => ops.remove(table, id),
    async claimSession(userId, token, expiresAt) {
      const claim = await pool.query(
        `INSERT INTO app_user_sessions (user_id, token, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
           WHERE app_user_sessions.expires_at < NOW()
              OR app_user_sessions.token = EXCLUDED.token
         RETURNING user_id`,
        [String(userId), token, expiresAt]
      );
      return claim.rows.length > 0;
    },
    async releaseSession(userId, { token, force } = {}) {
      if (force) {
        await pool.query("DELETE FROM app_user_sessions WHERE user_id = $1", [String(userId)]);
      } else {
        await pool.query("DELETE FROM app_user_sessions WHERE user_id = $1 AND token = $2", [
          String(userId),
          String(token || ""),
        ]);
      }
    },
    async transaction(fn) {
      const client = await pool.connect();
      const tx = clientOps(client);
      try {
        await client.query("BEGIN");
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

module.exports = {
  TABLES,
  createStore,
  createFileStore,
};
