const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

/**
 * GMGN AI Trader V1.1.2
 * 稳定修复版
 *
 * 目的：
 * 1. 修复 Railway 502
 * 2. 后端一定可以启动
 * 3. 优先读取 DexScreener 真实数据
 * 4. 失败时自动返回 demo，页面不白屏
 * 5. 不连接钱包，不自动买入
 */

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
    },
    {
      symbol: "DOGE2",
      name: "Doge 2.0",
      chain,
      address: "0xDemo333333333333333333333333333333333333",
      shortAddress: "0xDemo...3333",
      price: 0.000045,
      liquidity: 26000,
      volume24h: 98000,
      top10HolderRate: 39,
      priceChange1h: 88,
      ageMinutes: 75,
      buyTax: 5,
      sellTax: 5,
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
        "user-agent": "Mozilla/5.0 GMGN-AI-Trader-V1.1.2"
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

async function fetchDexFallback(chain) {
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

app.get("/", (req, res) => {
  res.json({
    name: "GMGN AI Trader V1.1.2",
    status: "运行中",
    mode: "稳定真实数据风险扫描",
    trading: false
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "V1.1.2",
    time: new Date().toISOString()
  });
});

app.get("/api/scan", async (req, res) => {
  const chain = req.query.chain || "bsc";

  try {
    let source = "dexscreener-fallback";
    let tokens = await fetchDexFallback(chain);

    if (!tokens.length) {
      source = "demo-no-real-data";
      tokens = mockTokens(chain);
    }

    tokens = tokens.map((token) => ({
      ...token,
      risk: calcRiskScore(token)
    }));

    res.json({
      ok: true,
      version: "V1.1.2",
      source,
      chain,
      tradingEnabled: false,
      updateTime: new Date().toISOString(),
      tokens
    });
  } catch (error) {
    const tokens = mockTokens(chain).map((token) => ({
      ...token,
      risk: calcRiskScore(token)
    }));

    res.json({
      ok: true,
      version: "V1.1.2",
      source: "demo-after-error",
      chain,
      tradingEnabled: false,
      updateTime: new Date().toISOString(),
      error: error.message,
      tokens
    });
  }
});

app.listen(PORT, () => {
  console.log(`GMGN AI Trader V1.1.2 running on port ${PORT}`);
});
