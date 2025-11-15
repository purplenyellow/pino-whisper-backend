// server.js — Pino Whisper backend
// Run: node server.js  (Node 18+)
// ENV: PORT (Render sets it), CORS_ORIGIN (your site, e.g. https://www.pinowhisper.com)

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// -----------------------------------------------------
// Basic health routes
// -----------------------------------------------------
app.get("/", (req, res) => {
  res.send("Pino Whisper backend is running 🌙");
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// -----------------------------------------------------
// 1) WHISPERS WALL (soft anonymous public posts)
// -----------------------------------------------------

// In-memory store for wall posts (for now; later replace with DB)
const wallPosts = []; // { id, text, nick, when, createdAt }

let nextWallId = 1;

function makeWhenLabel(dateString) {
  // For now just return "just now" for new posts.
  // Later you can format "2 min ago", etc.
  return "just now";
}

// GET /api/wall  -> list recent whispers
app.get("/api/wall", (req, res) => {
  // newest first
  const sorted = [...wallPosts].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json(sorted);
});

// POST /api/wall  -> add a new whisper
// body: { text, nick }
app.post("/api/wall", (req, res) => {
  try {
    const { text, nick } = req.body || {};
    const cleanText = (text || "").trim();
    const cleanNick = (nick || "someone").trim() || "someone";

    if (!cleanText) {
      return res.status(400).json({ error: "Text is required." });
    }

    const now = new Date();
    const item = {
      id: String(nextWallId++),
      text: cleanText,
      nick: cleanNick,
      when: makeWhenLabel(now.toISOString()),
      createdAt: now.toISOString()
    };

    wallPosts.push(item);

    // broadcast to all connected sockets
    io.emit("wall:new", item);

    return res.json(item);
  } catch (err) {
    console.error("Error in /api/wall POST", err);
    return res.status(500).json({ error: "Failed to post whisper." });
  }
});

// -----------------------------------------------------
// 2) MOONWISH WALLET (real shared balance inside Pino Whisper)
// -----------------------------------------------------
//
// IMPORTANT:
// - This is "real" inside your app: one wallet, one balance, shared across devices.
// - For production, replace the in-memory Map with a database.
// - Later you can connect these records to a real blockchain token.
//
// Frontend already calls POST /api/wallet from wallet.js.
// -----------------------------------------------------

const wallets = new Map(); // key: mnemonicHash -> wallet object
const START_BALANCE = 1.0; // starting MoonWish Coins for new wallet
const DECIMALS = 3;

// helper: hash mnemonic so we never store raw words
function hashMnemonic(mnemonic) {
  return crypto.createHash("sha256").update(String(mnemonic)).digest("hex");
}

// helper: derive a pretty address from the hash
function deriveAddressFromHash(hashHex) {
  const h = (hashHex || "").slice(0, 16).toUpperCase().padEnd(16, "0");
  return (
    "MWC-" +
    h.slice(0, 4) + "-" +
    h.slice(4, 8) + "-" +
    h.slice(8, 12) + "-" +
    h.slice(12, 16)
  );
}

function getOrCreateWallet(nickname, mnemonic) {
  const nick = (nickname || "Guest").slice(0, 24);
  const mnRaw = (mnemonic || "").trim();
  if (!mnRaw) return null;

  const key = hashMnemonic(mnRaw);
  let w = wallets.get(key);

  if (!w) {
    const addr = deriveAddressFromHash(key);
    w = {
      id: key,
      address: addr,
      nickname: nick,
      balance: START_BALANCE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    wallets.set(key, w);
  } else {
    if (nick && nick !== w.nickname) {
      w.nickname = nick;
    }
    w.updatedAt = new Date().toISOString();
  }

  return w;
}

function publicWallet(w) {
  if (!w) return null;
  return {
    address: w.address,
    nickname: w.nickname,
    balance: Number(w.balance.toFixed(DECIMALS)),
    createdAt: w.createdAt,
    updatedAt: w.updatedAt
  };
}

// POST /api/wallet -> create or fetch wallet for nickname + mnemonic
// body: { nickname, mnemonic }
app.post("/api/wallet", (req, res) => {
  try {
    const { nickname, mnemonic } = req.body || {};
    const w = getOrCreateWallet(nickname, mnemonic);
    if (!w) {
      return res.status(400).json({ error: "Missing mnemonic." });
    }
    return res.json(publicWallet(w));
  } catch (err) {
    console.error("Wallet error", err);
    return res.status(500).json({ error: "Wallet error." });
  }
});

// POST /api/wallet/earn -> add balance
// body: { address, amount, reason }
app.post("/api/wallet/earn", (req, res) => {
  try {
    const { address, amount, reason } = req.body || {};
    if (!address || typeof amount !== "number" || !Number.isFinite(amount)) {
      return res.status(400).json({ error: "Invalid payload." });
    }

    let target = null;
    for (const w of wallets.values()) {
      if (w.address === address) {
        target = w;
        break;
      }
    }
    if (!target) {
      return res.status(404).json({ error: "Wallet not found." });
    }

    target.balance = Number((target.balance + amount).toFixed(DECIMALS));
    target.updatedAt = new Date().toISOString();

    // TODO: record tx history later
    return res.json(publicWallet(target));
  } catch (err) {
    console.error("Wallet earn error", err);
    return res.status(500).json({ error: "Wallet earn error." });
  }
});

// POST /api/wallet/spend -> subtract balance if enough
// body: { address, amount, reason }
app.post("/api/wallet/spend", (req, res) => {
  try {
    const { address, amount, reason } = req.body || {};
    if (!address || typeof amount !== "number" || !Number.isFinite(amount)) {
      return res.status(400).json({ error: "Invalid payload." });
    }

    let target = null;
    for (const w of wallets.values()) {
      if (w.address === address) {
        target = w;
        break;
      }
    }
    if (!target) {
      return res.status(404).json({ error: "Wallet not found." });
    }

    if (target.balance < amount) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    target.balance = Number((target.balance - amount).toFixed(DECIMALS));
    target.updatedAt = new Date().toISOString();

    // TODO: record tx history later
    return res.json(publicWallet(target));
  } catch (err) {
    console.error("Wallet spend error", err);
    return res.status(500).json({ error: "Wallet spend error." });
  }
});

// GET /api/wallet/:address -> fetch wallet summary by address
app.get("/api/wallet/:address", (req, res) => {
  try {
    const address = req.params.address;
    if (!address) {
      return res.status(400).json({ error: "Missing address." });
    }

    let target = null;
    for (const w of wallets.values()) {
      if (w.address === address) {
        target = w;
        break;
      }
    }
    if (!target) {
      return res.status(404).json({ error: "Wallet not found." });
    }

    return res.json(publicWallet(target));
  } catch (err) {
    console.error("Wallet fetch error", err);
    return res.status(500).json({ error: "Wallet fetch error." });
  }
});

// -----------------------------------------------------
// 3) SOCKET.IO — basic setup (wall events for now)
// -----------------------------------------------------

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });

  // In future you can add private chat sockets here
  // e.g. socket.on("chat:send", ...) etc.
});

// -----------------------------------------------------
// Start server
// -----------------------------------------------------

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Pino Whisper backend listening on port ${PORT}`);
});

