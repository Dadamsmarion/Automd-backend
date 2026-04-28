const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["POST", "GET"],
}));

const freeLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers["x-user-id"] || req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: "daily_limit_reached",
      message: "You've used all 5 free diagnoses today. Upgrade to AutoMD Pro for unlimited access.",
      upgradeUrl: process.env.STRIPE_PAYMENT_LINK || "https://automd.app/upgrade",
    });
  },
});

const premiumLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 500,
  keyGenerator: (req) => req.headers["x-user-id"] || req.ip,
});

function checkTier(req, res, next) {
  const token = req.headers["x-subscription-token"];
  req.isPremium = !!token && token !== "free";
  next();
}

function getLimiter(req, res, next) {
  if (req.isPremium) return premiumLimiter(req, res, next);
  return freeLimiter(req, res, next);
}

function injectAffiliateLinks(parts) {
  if (!Array.isArray(parts)) return parts;
  return parts.map(part => {
    if (!part.url) return part;
    try {
      if (part.url.includes("amazon.com")) {
        const url = new URL(part.url.startsWith("http") ? part.url : "https://" + part.url);
        url.searchParams.set("tag", process.env.AMAZON_AFFILIATE_TAG || "automd-20");
        return { ...part, url: url.toString() };
      }
      if (part.url.includes("ebay.com")) {
        const campaignId = process.env.EBAY_CAMPAIGN_ID || "711-53200-19255-0";
        const encoded = encodeURIComponent(part.url.startsWith("http") ? part.url : "https://" + part.url);
        return { ...part, url: "https://rover.ebay.com/rover/1/" + campaignId + "/1?mpre=" + encoded };
      }
    } catch (e) { return part; }
    return part;
  });
}

async function callClaude(body) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return response.json();
}

app.post("/api/diagnose", checkTier, getLimiter, async (req, res) => {
  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }
  try {
    const data = await callClaude({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      ...(system ? { system } : {}),
      messages,
    });
    if (data.error) return res.status(500).json({ error: data.error.message });
    res.json(data);
  } catch (err) {
    console.error("Diagnose error:", err);
    res.status(500).json({ error: "Service temporarily unavailable" });
  }
});

app.post("/api/parts", checkTier, getLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }
  try {
    const data = await callClaude({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages,
    });
    if (data.error) return res.status(500).json({ error: data.error.message });
    if (data.content) {
      const text = data.content.map(b => b.text || "").join("");
      try {
        const cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
        const start = cleaned.search(/[\[{]/);
        const end = cleaned.lastIndexOf(cleaned[start] === "[" ? "]" : "}");
        const parts = JSON.parse(cleaned.slice(start, end + 1));
        return res.json({ parts: injectAffiliateLinks(parts) });
      } catch { return res.json({ parts: [] }); }
    }
    res.json({ parts: [] });
  } catch (err) {
    console.error("Parts error:", err);
    res.status(500).json({ error: "Service unavailable" });
  }
});

app.get("/api/health", (req, res) => res.json({ status: "ok", version: "1.0.0" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("AutoMD backend running on port " + PORT));
