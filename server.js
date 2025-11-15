import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Pool } from "pg";
import { randomBytes, createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(express.json());

// ---- CORS ----
const allowed = process.env.CORS_ORIGIN?.split(",").map(s => s.trim()) || ["*"];
app.use(
  cors({
    origin: (origin, cb) =>
      cb(null, allowed.includes("*") || allowed.includes(origin)),
    credentials: false,
  })
);

// ---- Postgres ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

// ---- Helper: simple word list for wallets ----
const WORDS = [
  "moon", "seed", "wish", "dream", "soft", "calm", "gentle", "leaf",
  "river", "stone", "dawn", "glow", "quiet", "petal", "spark", "night",
  "honey", "moss", "cloud", "garden", "cotton", "feather", "light",
  "ember", "gold", "whisper", "sprout", "breeze", "shell", "canyon",
  "star", "branch", "candle", "mint", "bamboo", "pearl"
];

function genWords(n = 12) {
  const b = randomBytes(n);
  return Array.from(b, (x, i) => WORDS[(x + i) % WORDS.length]).slice(0, n);
}

function addrFromPhrase(phrase) {
  const h = createHash("sha256")
    .update(phrase + "|v1")
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `PW-${h}`;
}

// ---- Health ----
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- Wallet API ----

// Create/Update wallet from { nickname, mnemonic }
app.post("/api/wallet", async (req, res) => {
  try {
    const nickname = String(req.body?.nickname || "").trim().slice(0, 64);
    const mnemonic = String(req.body?.mnemonic || "").trim();

    const words = mnemonic.split(/\s+/).filter(Boolean);
    if (!nickname || words.length < 12) {
      return res.status(400).json({ error: "bad_payload" });
    }

    const address = addrFromPhrase(mnemonic);

    const q = `
      INSERT INTO wallets (id, address, words, alias, balance, created_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 0, now())
      ON CONFLICT (address)
      DO UPDATE SET alias = EXCLUDED.alias
      RETURNING id, address, alias, balance, created_at
    `;
    const { rows } = await pool.query(q, [address, mnemonic, nickname]);

    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "wallet_upsert_failed" });
  }
});

app.post("/api/wallet/create", async (req, res) => {
  const alias = (req.body?.alias || "").slice(0, 64);
  const words = genWords(12);
  const phrase = words.join(" ");
  const address = addrFromPhrase(phrase);
  const id = uuidv4();
  try {
    const q = `
      INSERT INTO wallets (id,address,words,alias,balance,created_at)
      VALUES ($1,$2,$3,$4,$5,now())
      RETURNING id,address,alias,balance,created_at
    `;
    const { rows } = await pool.query(q, [id, address, phrase, alias, 0]);
    res.json({ ...rows[0], words });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "create_failed" });
  }
});

app.post("/api/wallet/import", async (req, res) => {
  const phrase = (req.body?.words || "").trim();
  if (!phrase || phrase.split(/\s+/).length !== 12) {
    return res.status(400).json({ error: "need_12_words" });
  }
  const address = addrFromPhrase(phrase);
  try {
    const found = await pool.query(
      `SELECT id,address,alias,balance,created_at FROM wallets WHERE words=$1`,
      [phrase]
    );
    if (found.rowCount > 0) {
      return res.json(found.rows[0]);
    }
    const id = uuidv4();
    const q = `
      INSERT INTO wallets (id,address,words,alias,balance,created_at)
      VALUES ($1,$2,$3,$4,$5,now())
      RETURNING id,address,alias,balance,created_at
    `;
    const { rows } = await pool.query(q, [id, address, phrase, "", 0]);
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "import_failed" });
  }
});

app.get("/api/wallet/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,address,alias,balance,created_at FROM wallets WHERE id=$1`,
      [req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "fetch_failed" });
  }
});

// Award MWC
app.post("/api/wallet/:id/award", async (req, res) => {
  const amount = Math.max(0, parseInt(req.body?.amount || 0, 10));
  if (!amount) return res.status(400).json({ error: "bad_amount" });

  try {
    const { rows } = await pool.query(
      `UPDATE wallets SET balance = balance + $1 WHERE id=$2 RETURNING id,address,alias,balance,created_at`,
      [amount, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "award_failed" });
  }
});

// Spend MWC
app.post("/api/wallet/:id/spend", async (req, res) => {
  const amount = Math.max(0, parseInt(req.body?.amount || 0, 10));
  if (!amount) return res.status(400).json({ error: "bad_amount" });

  try {
    const { rows } = await pool.query(
      `SELECT balance FROM wallets WHERE id=$1`,
      [req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    if (rows[0].balance < amount) {
      return res.status(400).json({ error: "insufficient_funds" });
    }

    const upd = await pool.query(
      `UPDATE wallets SET balance = balance - $1 WHERE id=$2 RETURNING id,address,alias,balance,created_at`,
      [amount, req.params.id]
    );

    res.json(upd.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "spend_failed" });
  }
});

// ---- Whispers Wall API ----

const CREATE_WHISPERS_TABLE = `
  CREATE TABLE IF NOT EXISTS whispers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    text text NOT NULL,
    nick text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    likes integer NOT NULL DEFAULT 0
  );
`;

// Get latest whispers
app.get("/api/wall", async (req, res) => {
  try {
    await pool.query(CREATE_WHISPERS_TABLE);
    const { rows } = await pool.query(
      `SELECT id, text, nick, created_at FROM whispers
       ORDER BY created_at DESC
       LIMIT 50`
    );

    const mapped = rows.map(row => ({
      id: row.id,
      text: row.text,
      nick: row.nick || "someone",
      when: "just now",   // frontend can show a nicer string later
    }));

    res.json(mapped);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "wall_list_failed" });
  }
});

// Post a new whisper
app.post("/api/wall", async (req, res) => {
  try {
    await pool.query(CREATE_WHISPERS_TABLE);

    const rawText = String(req.body?.text || "").trim();
    const rawNick = String(req.body?.nick || "").trim();

    const text = rawText.slice(0, 500);
    const nick = (rawNick || "someone").slice(0, 40);

    if (!text) {
      return res.status(400).json({ error: "empty_text" });
    }

    const id = uuidv4();
    const q = `
      INSERT INTO whispers (id, text, nick, created_at, likes)
      VALUES ($1, $2, $3, now(), 0)
      RETURNING id, text, nick, created_at, likes
    `;
    const { rows } = await pool.query(q, [id, text, nick]);
    const row = rows[0];

    res.json({
      id: row.id,
      text: row.text,
      nick: row.nick,
      when: "just now",
      likes: row.likes,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "wall_create_failed" });
  }
});

// ---- Root route ----
app.get("/", (req, res) => {
  res.send("✨ Pino Whisper Backend is running ✨");
});

// ---- Start server ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Pino Whisper API on :${PORT}`));
