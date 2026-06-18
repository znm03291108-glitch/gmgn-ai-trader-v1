const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GMGN_API_KEY = process.env.GMGN_API_KEY || "";

/**
 * V1 说明：
 * 这个版本先不真实交易，只做风险扫描页面。
 * 如果 GMGN API Key 未配置，也会返回演示数据，方便先部署成功。
 */

function calcRiskScore(token) {
  let score = 100;
  const reasons = [];

  if (token.liquidity < 10000) {
    score -= 25;
    reasons.push("流动性偏低");
  }

  if (token.volume24h < 20000) {
    score -= 15;
    reasons.push("24小时交易量偏低");
  }

  if (token.top10HolderRate > 45) {
    score -= 25;
    reasons.push("前10持仓占比过高");
  }

  if (token.priceChange1h > 200) {
    score -= 20;
    reasons.push("1小时涨幅过高，可能追高");
  }

  if (token.ageMinutes < 30) {
    score -= 20;
    reasons.push("新盘时间太短");
  }

  if (token.buyTax > 10 || token.sellTax > 10) {
    score -= 30;
    reasons.push("买卖税过高");
  }

  if (token.isHoneypot) {
    score -= 80;
    reasons.push("疑似貔貅盘/不可卖");
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

function mockTokens(chain = "bsc") {
  return [
    {
      symbol: "PEPEAI",
      name: "Pepe AI",
      chain,
      address: "0xDemo111111111111111111111111111111111111",
      price: 0.0000123,
      liquidity: 85000,
      volume24h: 420000,
      top10HolderRate: 28,
      priceChange1h: 35,
      ageMinutes: 240,
      buyTax: 3,
      sellTax: 3,
      isHoneypot: false
    },
    {
      symbol: "MOONX",
      name: "Moon X",
      chain,
      address: "0xDemo222222222222222222222222222222222222",
      price: 0.00000091,
      liquidity: 5200,
      volume24h: 11000,
      top10HolderRate: 62,
      priceChange1h: 310,
      ageMinutes: 12,
      buyTax: 15,
      sellTax: 20,
      isHoneypot: false
    },
    {
      symbol: "DOGE2",
      name: "Doge 2.0",
      chain,
      address: "0xDemo333333333333333333333333333333333333",
      price: 0.000045,
      liquidity: 26000,
      volume24h: 98000,
      top10HolderRate: 39,
      priceChange1h: 88,
      ageMinutes: 75,
      buyTax: 5,
      sellTax: 5,
      isHoneypot: false
    }
  ];
}

app.get("/", (req, res) => {
  res.json({
    name: "GMGN AI Trader V1",
    status: "running",
    mode: "risk-scanner-only",
    trading: false
  });
});

app.get("/api/scan", async (req, res) => {
  try {
    const chain = req.query.chain || "bsc";

    /**
     * 这里先返回演示数据。
     * 后面 V1.1 再根据你实际申请到的 GMGN API Key，
     * 替换成真实 GMGN API 请求。
     */
    const tokens = mockTokens(chain).map((token) => {
      return {
        ...token,
        risk: calcRiskScore(token)
      };
    });

    res.json({
      ok: true,
      source: GMGN_API_KEY ? "gmgn-ready-demo" : "demo",
      chain,
      tradingEnabled: false,
      updateTime: new Date().toISOString(),
      tokens
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "scan failed",
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`GMGN AI Trader V1 running on port ${PORT}`);
});
