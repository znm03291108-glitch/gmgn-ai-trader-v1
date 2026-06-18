const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

/**
 * GMGN AI Trader V1.1
 * 真实热门币数据版
 *
 * 说明：
 * 1. 优先尝试从 GMGN 公开行情接口读取热门币数据。
 * 2. 如果 GMGN 接口失败，自动切换为 DexScreener 搜索数据。
 * 3. 如果外部接口都失败，才返回 demo 数据，保证页面不会白屏。
 * 4. V1.1 不连接钱包，不自动交易，只做风险扫描。
 */

const CHAIN_MAP = {
  bsc: "bsc",
  eth: "eth",
  base: "base",
  sol: "sol"
};

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
  const top10HolderRate = toNumber(token.top10HolderRate);
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

  if (top10HolderRate > 45) {
    score -= 25;
    reasons.push("前10持仓占比过高");
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

function normalizeGmgnToken(raw, chain) {
  const createdAt =
    raw.creation_timestamp ||
    raw.created_at ||
    raw.open_timestamp ||
    raw.pool_created_at ||
    0;

  let ageMinutes = 0;
  const ts = Number(createdAt);
  if (ts > 0) {
    const ms = ts < 10000000000 ? ts * 1000 : ts;
    ageMinutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  }

  const address =
    raw.address ||
    raw.token_address ||
    raw.base_address ||
    raw.base_token_address ||
    raw.id ||
    "";

  const symbol =
    raw.symbol ||
    raw.base_token_symbol ||
    raw.token_symbol ||
    "UNKNOWN";

  const name =
    raw.name ||
    raw.base_token_name ||
    raw.token_name ||
    symbol;

  const liquidity =
    raw.liquidity ||
    raw.liquidity_usd ||
    raw.pool_liquidity ||
    raw.reserve_usd ||
    0;

  const volume24h =
    raw.volume24h ||
    raw.volume_24h ||
    raw.volume ||
    raw.volume_usd ||
    raw.swap_volume_24h ||
    0;

  const price =
    raw.price ||
    raw.price_usd ||
    raw.usd_price ||
    0;

  const priceChange1h =
    raw.price_change_1h ||
    raw.price_change_percent1h ||
    raw.price_change_percent_1h ||
    raw.change_1h ||
    0;

  const top10HolderRate =
    raw.top_10_holder_rate ||
    raw.top10_holder_rate ||
    raw.top10HolderRate ||
    0;

  const buyTax =
    raw.buy_tax ||
    raw.buyTax ||
    0;

  const sellTax =
    raw.sell_tax ||
    raw.sellTax ||
    0;

  const isHoneypot =
    raw.is_honeypot === true ||
    raw.honeypot === true ||
    raw.isHoneypot === true;

  return {
    symbol,
    name,
    chain,
    address,
    shortAddress: shortAddress(address),
    price: toNumber(price),
    liquidity: toNumber(liquidity),
    volume24h: toNumber(volume24h),
    top10HolderRate: toNumber(top10HolderRate),
    priceChange1h: toNumber(priceChange1h),
    ageMinutes,
    buyTax: toNumber(buyTax),
    sellTax: toNumber(sellTax),
    isHoneypot,
    gmgnUrl: address ? `https://gmgn.ai/${chain}/token/${address}` : ""
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
      gmgnUrl: ""
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
      gmgnUrl: ""
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
      gmgnUrl: ""
    }
  ];
}

async function fetchGmgnTrending(chain) {
  const gmgnChain = CHAIN_MAP[chain] || "bsc";

  const urls = [
    `https://gmgn.ai/defi/quotation/v1/rank/${gmgnChain}/swaps/1h?orderby=volume&direction=desc&filters[]=not_honeypot`,
    `https://gmgn.ai/defi/quotation/v1/rank/${gmgnChain}/swaps/24h?orderby=volume&direction=desc&filters[]=not_honeypot`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "Mozilla/5.0 GMGN-AI-Trader-V1.1"
        }
      });

      if (!res.ok) continue;

      const data = await res.json();

      let list = [];
      if (Array.isArray(data)) list = data;
      if (Array.isArray(data.data)) list = data.data;
      if (data.data && Array.isArray(data.data.rank)) list = data.data.rank;
      if (data.data && Array.isArray(data.data.list)) list = data.data.list;
      if (data.data && Array.isArray(data.data.tokens)) list = data.data.tokens;

      if (list.length > 0) {
        return list.slice(0, 20).map((item) => normalizeGmgnToken(item, gmgnChain));
      }
    } catch (err) {
      continue;
    }
  }

  return [];
}

async function fetchDexFallback(chain) {
  const queryMap = {
    bsc: "bnb",
    eth: "ethereum",
    base: "base",
    sol: "solana"
  };

  const q = queryMap[chain] || "bnb";
  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;

  const res = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 GMGN-AI-Trader-V1.1"
    }
  });

  if (!res.ok) {
    throw new Error("DexScreener fallback failed");
  }

  const data = await res.json();
  const pairs = Array.isArray(data.pairs) ? data.pairs : [];

  const chainIdMap = {
    bsc: ["bsc"],
    eth: ["ethereum", "ether"],
    base: ["base"],
    sol: ["solana"]
  };

  const allowed = chainIdMap[chain] || ["bsc"];

  return pairs
    .filter((p) => allowed.includes(String(p.chainId || "").toLowerCase()))
    .sort((a, b) => toNumber(b.volume && b.volume.h24) - toNumber(a.volume && a.volume.h24))
    .slice(0, 20)
    .map((p) => normalizeDexToken(p, chain));
}

app.get("/", (req, res) => {
  res.json({
    name: "GMGN AI Trader V1.1",
    status: "运行中",
    mode: "真实数据风险扫描",
    trading: false
  });
});

app.get("/api/scan", async (req, res) => {
  const chain = req.query.chain || "bsc";

  try {
    let source = "gmgn";
    let tokens = await fetchGmgnTrending(chain);

    if (!tokens.length) {
      source = "dexscreener-fallback";
      tokens = await fetchDexFallback(chain);
    }

    if (!tokens.length) {
      source = "demo";
      tokens = mockTokens(chain);
    }

    tokens = tokens.map((token) => ({
      ...token,
      risk: calcRiskScore(token)
    }));

    res.json({
      ok: true,
      version: "V1.1",
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
      version: "V1.1",
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
  console.log(`GMGN AI Trader V1.1 running on port ${PORT}`);
});
