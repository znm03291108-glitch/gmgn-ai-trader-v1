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

/**
 * GMGN AI Trader V1.2.6
 * 信号质量增强版
 *
 * 说明：
 * 1. 只提醒，不自动买入。
 * 2. 保留黑名单 / 白名单。
 * 3. 新增信号质量评分 signal。
 * 4. 新增推荐等级 S / A / B / C。
 * 5. 正常推送只推真实符合规则的币。
 * 6. 强制推送只测试 Telegram。
 */

function parseListEnv(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}

const BLACKLIST_SYMBOLS = parseListEnv(process.env.BLACKLIST_SYMBOLS || "");
const BLACKLIST_ADDRESSES = parseListEnv(process.env.BLACKLIST_ADDRESSES || "");
const WHITELIST_ADDRESSES = parseListEnv(process.env.WHITELIST_ADDRESSES || "");

const ALERT_RULES = {
  minScore: Number(process.env.MIN_SCORE || 90),
  minLiquidity: Number(process.env.MIN_LIQUIDITY || 300000),
  minVolume24h: Number(process.env.MIN_VOLUME_24H || 1000000),
  minAgeMinutes: Number(process.env.MIN_AGE_MINUTES || 60),
  maxAgeMinutes: Number(process.env.MAX_AGE_MINUTES || 10080),
  minChange1h: Number(process.env.MIN_CHANGE_1H || 0),
  maxChange1h: Number(process.env.MAX_CHANGE_1H || 30),
  maxAlertsPerRun: Number(process.env.MAX_ALERTS_PER_RUN || 3),
  cooldownHours: Number(process.env.ALERT_COOLDOWN_HOURS || 24),

  // V1.2.6 新增：信号质量规则
  minSignalScore: Number(process.env.MIN_SIGNAL_SCORE || 70),
  maxOldAgeMinutes: Number(process.env.MAX_OLD_AGE_MINUTES || 43200),
  healthyChange1hMin: Number(process.env.HEALTHY_CHANGE_1H_MIN || 0),
  healthyChange1hMax: Number(process.env.HEALTHY_CHANGE_1H_MAX || 25)
};

const sentAlertMap = new Map();

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shortAddress(addr = "") {
  if (!addr) return "";
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function cleanupSentMap() {
  const now = Date.now();
  const cooldownMs = ALERT_RULES.cooldownHours * 60 * 60 * 1000;

  for (const [key, time] of sentAlertMap.entries()) {
    if (now - time > cooldownMs) {
      sentAlertMap.delete(key);
    }
  }
}

function money(v) {
  const n = Number(v || 0);
  if (!n) return "$0";
  if (n >= 1000000000) return "$" + (n / 1000000000).toFixed(2) + "B";
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(2) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(2) + "K";
  return "$" + n.toFixed(2);
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

function calcSignalQuality(token) {
  let score = 0;
  const reasons = [];

  const liquidity = Number(token.liquidity || 0);
  const volume24h = Number(token.volume24h || 0);
  const change1h = Number(token.priceChange1h || 0);
  const ageMinutes = Number(token.ageMinutes || 0);
  const riskScore = token.risk ? Number(token.risk.score || 0) : 0;

  // 风险评分
  if (riskScore >= 90) {
    score += 20;
    reasons.push("风险评分较高");
  } else if (riskScore >= 75) {
    score += 10;
    reasons.push("风险评分一般");
  } else {
    reasons.push("风险评分偏低");
  }

  // 流动性
  if (liquidity >= 1000000) {
    score += 25;
    reasons.push("流动性充足");
  } else if (liquidity >= 300000) {
    score += 18;
    reasons.push("流动性达标");
  } else if (liquidity >= 100000) {
    score += 8;
    reasons.push("流动性一般");
  } else {
    reasons.push("流动性不足");
  }

  // 24H 成交量
  if (volume24h >= 5000000) {
    score += 25;
    reasons.push("24H交易量强");
  } else if (volume24h >= 1000000) {
    score += 18;
    reasons.push("24H交易量达标");
  } else if (volume24h >= 300000) {
    score += 8;
    reasons.push("24H交易量一般");
  } else {
    reasons.push("24H交易量不足");
  }

  // 1H 涨幅结构
  if (change1h >= 3 && change1h <= 20) {
    score += 20;
    reasons.push("1小时涨幅健康");
  } else if (change1h >= 0 && change1h < 3) {
    score += 10;
    reasons.push("1小时涨幅偏弱");
  } else if (change1h > 20 && change1h <= 30) {
    score += 8;
    reasons.push("1小时涨幅较高，注意追高");
  } else if (change1h < 0) {
    score -= 10;
    reasons.push("1小时涨幅为负");
  } else if (change1h > 30) {
    score -= 15;
    reasons.push("1小时涨幅过高，追高风险");
  }

  // 新盘时间结构
  if (ageMinutes >= 60 && ageMinutes <= 1440) {
    score += 20;
    reasons.push("新盘时间较合适");
  } else if (ageMinutes > 1440 && ageMinutes <= 10080) {
    score += 12;
    reasons.push("上线时间正常");
  } else if (ageMinutes > 10080 && ageMinutes <= ALERT_RULES.maxOldAgeMinutes) {
    score += 4;
    reasons.push("上线时间偏久");
  } else if (ageMinutes > ALERT_RULES.maxOldAgeMinutes) {
    score -= 15;
    reasons.push("老币时间过久");
  } else {
    reasons.push("新盘时间过短或未知");
  }

  if (token.isWhitelisted) {
    score += 10;
    reasons.push("白名单重点观察");
  }

  if (token.isBlacklisted) {
    score -= 50;
    reasons.push("命中黑名单");
  }

  if (score > 100) score = 100;
  if (score < 0) score = 0;

  let grade = "C";
  let label = "过滤";
  let advice = "暂不建议关注";

  if (score >= 85) {
    grade = "S";
    label = "重点观察";
    advice = "信号质量较强，可加入重点观察，但不要重仓";
  } else if (score >= 70) {
    grade = "A";
    label = "可以观察";
    advice = "信号质量达标，可以观察，不建议重仓";
  } else if (score >= 50) {
    grade = "B";
    label = "普通观察";
    advice = "信号一般，只适合观察";
  }

  return {
    score,
    grade,
    label,
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
        "user-agent": "Mozilla/5.0 GMGN-AI-Trader-V1.2.6"
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

function checkListStatus(token) {
  const symbol = String(token.symbol || "").toLowerCase();
  const name = String(token.name || "").toLowerCase();
  const address = String(token.address || "").toLowerCase();

  const isBlacklistedSymbol = BLACKLIST_SYMBOLS.some((word) => {
    return symbol.includes(word) || name.includes(word);
  });

  const isBlacklistedAddress = BLACKLIST_ADDRESSES.includes(address);
  const isWhitelistedAddress = WHITELIST_ADDRESSES.includes(address);

  return {
    isBlacklistedSymbol,
    isBlacklistedAddress,
    isBlacklisted: isBlacklistedSymbol || isBlacklistedAddress,
    isWhitelisted: isWhitelistedAddress
  };
}

function getAlertDecision(token) {
  const risk = token.risk || {};
  const signal = token.signal || {};
  const score = Number(risk.score || 0);
  const signalScore = Number(signal.score || 0);
  const liquidity = Number(token.liquidity || 0);
  const volume24h = Number(token.volume24h || 0);
  const change1h = Number(token.priceChange1h || 0);
  const ageMinutes = Number(token.ageMinutes || 0);

  const key = `${token.chain}:${token.address}`;
  const lastSentAt = sentAlertMap.get(key);
  const cooldownMs = ALERT_RULES.cooldownHours * 60 * 60 * 1000;

  const listStatus = checkListStatus(token);

  const failed = [];

  if (!token.address) failed.push("无合约地址");

  if (listStatus.isBlacklistedSymbol) {
    failed.push("命中币名/符号黑名单");
  }

  if (listStatus.isBlacklistedAddress) {
    failed.push("命中合约地址黑名单");
  }

  if (score < ALERT_RULES.minScore) failed.push(`风险评分低于 ${ALERT_RULES.minScore}`);
  if (signalScore < ALERT_RULES.minSignalScore) failed.push(`信号评分低于 ${ALERT_RULES.minSignalScore}`);
  if (liquidity < ALERT_RULES.minLiquidity) failed.push(`流动性低于 ${money(ALERT_RULES.minLiquidity)}`);
  if (volume24h < ALERT_RULES.minVolume24h) failed.push(`24H交易量低于 ${money(ALERT_RULES.minVolume24h)}`);
  if (ageMinutes < ALERT_RULES.minAgeMinutes) failed.push(`新盘时间小于 ${ALERT_RULES.minAgeMinutes} 分钟`);
  if (ageMinutes > ALERT_RULES.maxAgeMinutes) failed.push(`新盘时间超过 ${ALERT_RULES.maxAgeMinutes} 分钟`);
  if (change1h < ALERT_RULES.minChange1h) failed.push(`1小时涨幅低于 ${ALERT_RULES.minChange1h}%`);
  if (change1h > ALERT_RULES.maxChange1h) failed.push(`1小时涨幅高于 ${ALERT_RULES.maxChange1h}%`);

  if (lastSentAt && Date.now() - lastSentAt < cooldownMs) {
    failed.push(`${ALERT_RULES.cooldownHours}小时内已提醒过`);
  }

  return {
    ok: failed.length === 0,
    key,
    failed,
    isWhitelisted: listStatus.isWhitelisted,
    isBlacklisted: listStatus.isBlacklisted
  };
}

function buildTelegramMessage(token, force = false, listStatus = {}) {
  const risk = token.risk || {};
  const signal = token.signal || {};
  const whiteTag = listStatus.isWhitelisted ? "⭐ 白名单重点观察" : "";
  const blackTag = listStatus.isBlacklisted ? "⛔ 黑名单命中" : "";

  return [
    force ? "🧪 GMGN AI Trader V1.2.6 强制测试提醒" : "🚨 GMGN AI Trader V1.2.6 精准候选币提醒",
    "",
    force ? "模式：强制测试模式，已绕过过滤规则，不代表真实符合条件。" : "模式：正常精准过滤模式，已通过提醒规则。",
    whiteTag,
    blackTag,
    "",
    `币种：${token.symbol || "UNKNOWN"}`,
    `名称：${token.name || "-"}`,
    `链：${token.chain}`,
    `风险评分：${risk.score}/100`,
    `风险等级：${risk.level}`,
    `信号评分：${signal.score}/100`,
    `推荐等级：${signal.grade}级 - ${signal.label}`,
    "",
    `价格：${token.price}`,
    `流动性：${money(token.liquidity)}`,
    `24H交易量：${money(token.volume24h)}`,
    `1小时涨幅：${Number(token.priceChange1h || 0).toFixed(2)}%`,
    `新盘时间：${Number(token.ageMinutes || 0)} 分钟`,
    "",
    `AI建议：${signal.advice || risk.advice || "仅供观察"}`,
    `信号原因：${signal.reasons && signal.reasons.length ? signal.reasons.join("、") : "暂无"}`,
    `风险原因：${risk.reasons && risk.reasons.length ? risk.reasons.join("、") : "暂未发现明显高危项"}`,
    "",
    "合约地址：",
    `${token.address}`,
    "",
    token.gmgnUrl ? `GMGN：${token.gmgnUrl}` : "",
    token.dexUrl ? `Dex：${token.dexUrl}` : "",
    "",
    `提醒规则：风险评分>=${ALERT_RULES.minScore}，信号评分>=${ALERT_RULES.minSignalScore}，流动性>=${money(ALERT_RULES.minLiquidity)}，24H量>=${money(ALERT_RULES.minVolume24h)}，1H涨幅 ${ALERT_RULES.minChange1h}%~${ALERT_RULES.maxChange1h}%`,
    "",
    "提醒：这不是投资建议，不要重仓跟买。"
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
        error: data.description || "Telegram send failed",
        data
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

  tokens = tokens.map((token) => {
    const risk = calcRiskScore(token);
    const listStatus = checkListStatus(token);

    const baseToken = {
      ...token,
      risk,
      isWhitelisted: listStatus.isWhitelisted,
      isBlacklisted: listStatus.isBlacklisted
    };

    const signal = calcSignalQuality(baseToken);

    return {
      ...baseToken,
      signal
    };
  });

  return {
    source,
    tokens
  };
}

async function scanAndAlert(chain = "bsc", force = false) {
  cleanupSentMap();

  const result = await scanTokens(chain);
  const tokens = result.tokens || [];

  const diagnostics = [];
  const realCandidates = [];

  for (const token of tokens) {
    const decision = getAlertDecision(token);

    diagnostics.push({
      symbol: token.symbol,
      address: token.address,
      score: token.risk ? token.risk.score : 0,
      signalScore: token.signal ? token.signal.score : 0,
      signalGrade: token.signal ? token.signal.grade : "C",
      signalLabel: token.signal ? token.signal.label : "过滤",
      liquidity: token.liquidity,
      volume24h: token.volume24h,
      change1h: token.priceChange1h,
      ageMinutes: token.ageMinutes,
      canSend: decision.ok,
      failed: decision.failed,
      isWhitelisted: decision.isWhitelisted,
      isBlacklisted: decision.isBlacklisted
    });

    if (decision.ok) {
      realCandidates.push({
        token,
        decision
      });
    }
  }

  let selected = [];

  if (force) {
    const firstToken = tokens.find((t) => t.address);

    if (firstToken) {
      selected = [
        {
          token: firstToken,
          decision: {
            key: `${firstToken.chain}:${firstToken.address}`,
            failed: ["强制测试模式：已绕过过滤规则"]
          },
          forceTest: true
        }
      ];
    }
  } else {
    selected = realCandidates
      .sort((a, b) => {
        const aw = a.decision.isWhitelisted ? 1 : 0;
        const bw = b.decision.isWhitelisted ? 1 : 0;
        if (bw !== aw) return bw - aw;

        const as = Number(a.token.signal ? a.token.signal.score : 0);
        const bs = Number(b.token.signal ? b.token.signal.score : 0);
        if (bs !== as) return bs - as;

        const av = Number(a.token.volume24h || 0);
        const bv = Number(b.token.volume24h || 0);
        return bv - av;
      })
      .slice(0, ALERT_RULES.maxAlertsPerRun);
  }

  const sent = [];
  const failedSend = [];

  for (const item of selected) {
    const token = item.token;
    const listStatus = checkListStatus(token);
    const msg = buildTelegramMessage(token, force, listStatus);
    const tg = await sendTelegram(msg);

    if (tg.ok) {
      if (!force) {
        sentAlertMap.set(item.decision.key, Date.now());
      }

      sent.push({
        symbol: token.symbol,
        address: token.address,
        mode: force ? "force-test" : "normal-alert",
        isWhitelisted: listStatus.isWhitelisted,
        isBlacklisted: listStatus.isBlacklisted,
        signalScore: token.signal ? token.signal.score : 0,
        signalGrade: token.signal ? token.signal.grade : "C"
      });
    } else {
      failedSend.push({
        symbol: token.symbol,
        address: token.address,
        error: tg.error
      });
    }
  }

  return {
    source: result.source,
    total: tokens.length,
    rules: ALERT_RULES,
    force,
    mode: force ? "force-test" : "normal-alert",
    note: force
      ? "强制测试模式：只用于测试 Telegram，已绕过过滤规则，不代表真实符合条件。"
      : "正常精准过滤模式：只推送真实符合规则、信号评分达标且未命中黑名单的币。",
    alertCandidates: realCandidates.length,
    selectedForSend: selected.length,
    sentCount: sent.length,
    sent,
    failedSend,
    diagnostics
  };
}

app.get("/", (req, res) => {
  res.json({
    name: "GMGN AI Trader V1.2.6",
    status: "运行中",
    mode: "信号质量增强版",
    trading: false,
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    autoAlert: AUTO_ALERT,
    scanIntervalSeconds: SCAN_INTERVAL_SECONDS,
    rules: ALERT_RULES,
    blacklistSymbols: BLACKLIST_SYMBOLS,
    blacklistAddressesCount: BLACKLIST_ADDRESSES.length,
    whitelistAddressesCount: WHITELIST_ADDRESSES.length
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    version: "V1.2.6",
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    autoAlert: AUTO_ALERT,
    scanIntervalSeconds: SCAN_INTERVAL_SECONDS,
    rules: ALERT_RULES,
    sentCacheSize: sentAlertMap.size,
    blacklistSymbols: BLACKLIST_SYMBOLS,
    blacklistAddressesCount: BLACKLIST_ADDRESSES.length,
    whitelistAddressesCount: WHITELIST_ADDRESSES.length
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "V1.2.6",
    telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    time: new Date().toISOString()
  });
});

app.get("/api/telegram/test", async (req, res) => {
  const text = [
    "✅ GMGN AI Trader V1.2.6 Telegram 测试成功",
    "",
    "信号质量增强版已上线。",
    "",
    `黑名单符号：${BLACKLIST_SYMBOLS.length ? BLACKLIST_SYMBOLS.join(", ") : "未设置"}`,
    `黑名单地址数量：${BLACKLIST_ADDRESSES.length}`,
    `白名单地址数量：${WHITELIST_ADDRESSES.length}`,
    "",
    `规则：风险评分>=${ALERT_RULES.minScore}，信号评分>=${ALERT_RULES.minSignalScore}，流动性>=${money(ALERT_RULES.minLiquidity)}，24H量>=${money(ALERT_RULES.minVolume24h)}，每次最多${ALERT_RULES.maxAlertsPerRun}个。`,
    "",
    "当前模式：只提醒，不自动买入。"
  ].join("\n");

  const result = await sendTelegram(text);

  res.json({
    ok: result.ok,
    version: "V1.2.6",
    result
  });
});

app.get("/api/scan", async (req, res) => {
  const chain = req.query.chain || "bsc";
  const notify = String(req.query.notify || "0") === "1";
  const force = String(req.query.force || "0") === "1";

  try {
    const result = await scanTokens(chain);

    let alertResult = null;

    if (notify) {
      alertResult = await scanAndAlert(chain, force);
    }

    res.json({
      ok: true,
      version: "V1.2.6",
      source: result.source,
      chain,
      tradingEnabled: false,
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      notify,
      force,
      alertResult,
      updateTime: new Date().toISOString(),
      tokens: result.tokens
    });
  } catch (error) {
    const tokens = mockTokens(chain).map((token) => {
      const risk = calcRiskScore(token);
      const baseToken = {
        ...token,
        risk,
        isWhitelisted: false,
        isBlacklisted: false
      };

      return {
        ...baseToken,
        signal: calcSignalQuality(baseToken)
      };
    });

    res.json({
      ok: true,
      version: "V1.2.6",
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
  const force = String(req.query.force || "0") === "1";

  try {
    const result = await scanAndAlert(chain, force);

    res.json({
      ok: true,
      version: "V1.2.6",
      chain,
      result,
      time: new Date().toISOString()
    });
  } catch (err) {
    res.json({
      ok: false,
      version: "V1.2.6",
      error: err.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("GMGN AI Trader V1.2.6 running on port " + PORT);

  if (AUTO_ALERT) {
    const intervalMs = Math.max(60, SCAN_INTERVAL_SECONDS) * 1000;

    console.log("Auto alert enabled. Interval:", intervalMs);

    setInterval(async () => {
      try {
        const result = await scanAndAlert("bsc", false);

        console.log("Auto alert result:", {
          total: result.total,
          alertCandidates: result.alertCandidates,
          selectedForSend: result.selectedForSend,
          sentCount: result.sentCount,
          mode: result.mode
        });
      } catch (err) {
        console.log("Auto alert error:", err.message);
      }
    }, intervalMs);
  }
});
