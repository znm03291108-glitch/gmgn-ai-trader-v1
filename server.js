const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const AUTO_ALERT = String(process.env.AUTO_ALERT || "false").toLowerCase() === "true";
const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 60);

const sentAlertKeys = new Set();

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortAddress(addr = "") {
  if (!addr) return "";
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function calcRiskScore(token) {
  let score = 100;
  const reasons = [];

  const liquidity = toNumber(token.liquidity);
  const volume24h = toNumber(token.volume24h);
  const priceChange1h = toNumber(token.priceChange1h);
  const ageMinutes = toNumber(token.ageMinutes);
  const buyTax = toNumber(token.buyTax);
  const sellTax = toNumber(token.sellTax);

  if (liquidity > 0 && liquidity < 10000) {
    score -= 25;
    reasons.push("流动性偏低");
  }

  if (volume24h > 0 && volume24h < 20000) {
    score -= 15;
    reasons.push("24小时交易量偏低");
  }

  if (priceChange1h > 150) {
    score -= 20;
    reasons.push("1小时涨幅过高，可能追高");
  }

  if (ageMinutes > 0 && ageMinutes < 30) {
    score -= 20;
    reasons.push("新盘时间太短");
  }

  if (buyTax > 10 || sellTax > 10) {
    score -= 30;
    reasons.push("买卖税过高");
  }

  if (token.isHoneypot) {
    score -= 80;
    reasons.push("疑似貔貅盘/不可卖");
  }

  if (!token.address) {
    score -= 10;
    reasons.push("合约地址缺失");
  }

  if (score < 0) score = 0;

  let level = "低风险";
  let advice = "可以继续观察，不建议重仓";

  if (score < 75) {
    level = "中风险";
    advice = "只适合观察或极小金额试单";
  }

  if (score < 50) {
    level = "高风险";
    advice = "不建议买入";
  }

  if (score < 25) {
    level = "极高风险";
    advice = "禁止买入，风险过高";
  }

  return {
    score,
    level,
    advice,
    reasons
  };
}

function normalizeDexToken(pair, chain) {
  const base = pair.baseToken || {};
  const createdAt = pair.pairCreatedAt || 0;

  let ageMinutes = 0;
  if (createdAt > 0) {
    ageMinutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60000));
  }

  const address = base.address || "";

  return {
    symbol: base.symbol || "UNKNOWN",
    name: base.name || base.symbol || "UNKNOWN",
    chain,
    address,
    shortAddress: shortAddress(address),
    price: toNumber(pair.priceUsd),
    liquidity: toNumber(pair.liquidity && pair.liquidity.usd),
    volume24h: toNumber(pair.volume && pair.volume.h24),
    top10HolderRate: 0,
    priceChange1h: toNumber(pair.priceChange && pair.priceChange.h1),
    ageMinutes,
    buyTax: 0,
    sellTax: 0,
    isHoneypot: false,
    gmgnUrl: address ? `https://gmgn.ai/${chain}/token/${address}` : "",
    dexUrl: pair.url || ""
  };
}

function mockTokens(chain = "bsc") {
  return [
    {
      symbol: "PEPEAI",
      name: "Pepe AI",
      chain,
      address: "0xDemo111111111111111111111111111111111111",
      shortAddress: "0xDemo...1111",
      price: 0.0000123,
      liquidity: 85000,
      volume24h: 420000,
      top10HolderRate: 28,
      priceChange1h: 35,
      ageMinutes: 240,
      buyTax: 3,
      sellTax: 3,
      isHoneypot: false,
      gmgnUrl: "",
      dexUrl: ""
    },
    {
      symbol: "MOONX",
      name: "Moon X",
      chain,
      address: "0xDemo222222222222222222222222222222222222",
      shortAddress: "0xDemo...2222",
      price: 0.00000091,
      liquidity: 5200,
      volume24h: 11000,
      top10HolderRate: 62,
      priceChange1h: 310,
      ageMinutes: 12,
      buyTax: 15,
      sellTax: 20,
      isHoneypot: false,
      gmgnUrl: "",
      dexUrl: ""
    }
  ];
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 GMGN-AI-Trader-V1.2"
      }
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }

    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchDexData(chain) {
  const chainIdMap = {
    bsc: "bsc",
    eth: "ethereum",
    base: "base",
    sol: "solana"
  };

  const targetChain = chainIdMap[chain] || "bsc";

  const searchQueries = {
    bsc: ["bnb", "cake", "pancakeswap", "meme"],
    eth: ["eth", "pepe", "uniswap", "meme"],
    base: ["base", "weth", "aerodrome", "meme"],
    sol: ["sol", "raydium", "pump", "meme"]
  };

  const queries = searchQueries[chain] || searchQueries.bsc;
  const allPairs = [];

  for (const q of queries) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
      const data = await fetchJsonWithTimeout(url, 8000);

      const pairs = Array.isArray(data.pairs) ? data.pairs : [];

      const filtered = pairs.filter((p) => {
        const cid = String(p.chainId || "").toLowerCase();
        return cid === targetChain;
      });

      allPairs.push(...filtered);
    } catch (err) {
      console.log("Dex query failed:", q, err.message);
    }
  }

  const seen = new Set();

  return allPairs
    .filter((p) => {
      const base = p.baseToken || {};
      const key = `${p.chainId}-${base.address}`;
      if (!base.address || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const bv = toNumber(b.volume && b.volume.h24);
      const av = toNumber(a.volume && a.volume.h24);
      return bv - av;
    })
    .slice(0, 20)
    .map((p) => normalizeDexToken(p, chain));
}

function money(v) {
  const n = Number(v || 0);
  if (!n) return "$0";
  if (n >= 1000000000) return "$" + (n / 1000000000).toFixed(2) + "B";
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(2) + "K";
  return "$" + n.toFixed(2);
}

function shouldSendAlert(token) {
  const score = token.risk ? Number(token.risk.score || 0) : 0;
  const liquidity = Number(token.liquidity || 0);
  const volume24h = Number(token.volume24h || 0);
  const change1h = Number(token.priceChange1h || 0);

  if (score < 85) return false;
  if (liquidity < 50000) return false;
  if (volume24h < 100000) return false;
  if (change1h > 120) return false;
  if (!token.address) return false;

  return true;
}

function buildTelegramMessage(token) {
  const risk = token.risk || {};

  return [
    `🚨 GMGN AI Trader V1.2 发现低风险候选币`,
    ``,
    `币种：${token.symbol || "UNKNOWN"}`,
    `名称：${token.name || "-"}`,
    `链：${token.chain}`,
    `风险评分：${risk.score}/100`,
    `风险等级：${risk.level}`,
    ``,
    `价格：${token.price}`,
    `流动性：${money(token.liquidity)}`,
    `24H交易量：${money(token.volume24h)}`,
    `1小时涨幅：${Number(token.priceChange1h || 0).toFixed(2)}%`,
    `新盘时间：${Number(token.ageMinutes || 0)} 分钟`,
    ``,
    `AI建议：${risk.advice || "仅供观察"}`,
    `风险原因：${risk.reasons && risk.reasons.length ? risk.reasons.join("、") : "暂未发现明显高危项"}`,
    ``,
    `合约地址：`,
    `${token.address}`,
    ``,
    token.gmgnUrl ? `GMGN：${token.gmgnUrl}` : "",
    token.dexUrl ? `Dex：${token.dexUrl}` : "",
    ``,
    `提醒：这不是投资建议，不要重仓跟买。`
  ].filter(Boolean).join("\n");
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return {
      ok: false,
      error: "Telegram 环境变量未配置"
    };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      })
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        ok: false,
        error: data.description || "Telegram send failed"
      };
    }

    return {
      ok: true,
      data
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

async function scanTokens(chain = "bsc") {
  let source = "dexscreener-fallback";
  let tokens = await fetchDexData(chain);

  if (!tokens.length) {
    source = "demo-no-real-data";
    tokens = mockTokens(chain);
  }

  tokens = tokens.map((token) => ({
    ...token,
    risk: calcRiskScore(token)
  }));

  return {
    source,
    tokens
  };
}

async function scanAndAlert(chain = "bsc") {
  const result = await scanTokens(chain);
  const tokens = result.tokens || [];

  const alertTokens = tokens.filter(shouldSendAlert);
  const sent = [];

  for (const token of alertTokens) {
    const key = `${token.chain}:${token.address}`;

    if (sentAlertKeys.has(key)) {
      continue;
    }

    const msg = buildTelegramMessage(token);
    const tg = await sendTelegram(msg);

    if (tg.ok) {
      sentAlertKeys.add(key);
      sent.push({
        symbol: token.symbol,
        address: token.address
      });
    }
  }

  return {
    source: result.source,
    total: tokens.length,
    alertCandidates: alertTokens.length,
    sentCount: sent.length,
    sent
  };
}

app.get("/", (req, res) => {
  res.json({
    name: "GMGN AI Trader V1.2",
    status: "运行中",
    mode: "Telegram 自动提醒版",
    trading: false,
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    autoAlert: AUTO_ALERT,
    scanIntervalSeconds: SCAN_INTERVAL_SECONDS
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "V1.2",
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    time: new Date().toISOString()
  });
});

app.get("/api/telegram/test", async (req, res) => {
  const text = [
    "✅ GMGN AI Trader V1.2 Telegram 测试成功",
    "",
    "如果你收到这条消息，说明机器人已经配置成功。",
    "",
    "当前模式：只提醒，不自动买入。"
  ].join("\n");

  const result = await sendTelegram(text);

  res.json({
    ok: result.ok,
    version: "V1.2",
    result
  });
});

app.get("/api/scan", async (req, res) => {
  const chain = req.query.chain || "bsc";
  const notify = String(req.query.notify || "0") === "1";

  try {
    const result = await scanTokens(chain);

    let alertResult = null;
    if (notify) {
      alertResult = await scanAndAlert(chain);
    }

    res.json({
      ok: true,
      version: "V1.2",
      source: result.source,
      chain,
      tradingEnabled: false,
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      notify,
      alertResult,
      updateTime: new Date().toISOString(),
      tokens: result.tokens
    });
  } catch (error) {
    const tokens = mockTokens(chain).map((token) => ({
      ...token,
      risk: calcRiskScore(token)
    }));

    res.json({
      ok: true,
      version: "V1.2",
      source: "demo-after-error",
      chain,
      tradingEnabled: false,
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      updateTime: new Date().toISOString(),
      error: error.message,
      tokens
    });
  }
});

app.get("/api/alert/run", async (req, res) => {
  const chain = req.query.chain || "bsc";

  try {
    const result = await scanAndAlert(chain);

    res.json({
      ok: true,
      version: "V1.2",
      chain,
      result,
      time: new Date().toISOString()
    });
  } catch (err) {
    res.json({
      ok: false,
      version: "V1.2",
      error: err.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("GMGN AI Trader V1.2 running on port " + PORT);

  if (AUTO_ALERT) {
    const intervalMs = Math.max(30, SCAN_INTERVAL_SECONDS) * 1000;

    console.log("Auto alert enabled. Interval:", intervalMs);

    setInterval(async () => {
      try {
        const result = await scanAndAlert("bsc");
        console.log("Auto alert result:", result);
      } catch (err) {
        console.log("Auto alert error:", err.message);
      }
    }, intervalMs);
  }
});
