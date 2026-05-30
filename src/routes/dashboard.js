const axios = require('axios');
const express = require('express');
const fs = require('fs');
const router = express.Router();

const LOG_PATH = '/var/log/nginx/access.log';

// Nginx log format: $remote_addr - - [$time_local] "$request" $status $bytes "$http_referer" "$http_user_agent"
// Example: 71.190.142.90 - - [29/May/2026:17:25:17 +0200] "GET /x402/clinical/study?nct_id=NCT06164730 HTTP/1.1" 200 3509 "-" "node"
const LOG_REGEX = /^(\S+) - - \[([^\]]+)\] "(\w+) ([^ ]+) [^"]*" (\d+) \d+/;

const EXCLUDE_TERMS = ['bazaar-settle', 'settle-memory', 'agent_id=bazaar'];

function parseNginxTime(timeStr) {
  // Format: 29/May/2026:17:25:17 +0200
  const months = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };
  const m = timeStr.match(/(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-]\d+)/);
  if (!m) return null;
  const [, day, mon, year, hour, min, sec, tz] = m;
  const tzSign = tz[0] === '+' ? 1 : -1;
  const tzHours = parseInt(tz.slice(1, 3));
  const tzMins = parseInt(tz.slice(3, 5));
  const tzOffset = tzSign * (tzHours * 60 + tzMins) * 60 * 1000;
  const utcMs = Date.UTC(parseInt(year), months[mon], parseInt(day),
    parseInt(hour), parseInt(min), parseInt(sec));
  return new Date(utcMs - tzOffset);
}

function readLogs() {
  try {
    const lines = [];
    try { lines.push(...fs.readFileSync(LOG_PATH, 'utf8').split('\n')); } catch(e) {}
    try { lines.push(...fs.readFileSync(LOG_PATH + '.1', 'utf8').split('\n')); } catch(e) {}
    return lines;
  } catch (e) {
    return [];
  }
}

function isExcluded(line) {
  return EXCLUDE_TERMS.some(t => line.includes(t));
}

function buildStats(lines, now) {
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000);
  const cutoff1h = new Date(now - 60 * 60 * 1000);

  const paidCalls = [];
  const probes = [];

  for (const line of lines) {
    if (!line.includes('/x402')) continue;
    if (isExcluded(line)) continue;

    const m = line.match(LOG_REGEX);
    if (!m) continue;

    const [, ip, timeStr, method, path, status] = m;
    if (method !== 'GET' && method !== 'POST') continue;

    const ts = parseNginxTime(timeStr);
    if (!ts) continue;

    if (status === '200') {
      paidCalls.push({ ip, ts, method, path });
    } else if (status === '402') {
      probes.push({ ip, ts, path });
    }
  }

  // Filter to 24h
  const paid24h = paidCalls.filter(c => c.ts >= cutoff24h);
  const paid1h = paidCalls.filter(c => c.ts >= cutoff1h);
  const probes24h = probes.filter(p => p.ts >= cutoff24h);

  // Unique payers
  const uniqueIPs = new Set(paid24h.map(c => c.ip));

  // Top endpoints
  const epCount24h = {};
  const epCount1h = {};
  for (const c of paid24h) {
    const ep = c.path.split('?')[0];
    epCount24h[ep] = (epCount24h[ep] || 0) + 1;
  }
  for (const c of paid1h) {
    const ep = c.path.split('?')[0];
    epCount1h[ep] = (epCount1h[ep] || 0) + 1;
  }
  const topEndpoints = Object.entries(epCount24h)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ep, cnt]) => ({ endpoint: ep, calls_1h: epCount1h[ep] || 0, calls_24h: cnt }));

  // Paying agents
  const agentMap = {};
  for (const c of paid24h) {
    if (!agentMap[c.ip]) {
      agentMap[c.ip] = { ip: c.ip, total_calls: 0, last_endpoint: c.path, last_seen: c.ts, first_seen: c.ts };
    }
    agentMap[c.ip].total_calls++;
    if (c.ts > agentMap[c.ip].last_seen) {
      agentMap[c.ip].last_seen = c.ts;
      agentMap[c.ip].last_endpoint = c.path;
    }
    if (c.ts < agentMap[c.ip].first_seen) {
      agentMap[c.ip].first_seen = c.ts;
    }
  }
  const payingAgents = Object.values(agentMap)
    .sort((a, b) => b.total_calls - a.total_calls)
    .map(a => ({ ip: a.ip, total_calls: a.total_calls, last_endpoint: a.last_endpoint, last_seen: a.last_seen.toISOString(), first_seen: a.first_seen.toISOString() }));

  // Demand signals (probes)
  const probeCount = {};
  for (const p of probes24h) {
    const ep = p.path.split('?')[0];
    probeCount[ep] = (probeCount[ep] || 0) + 1;
  }
  const demandSignals = Object.entries(probeCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ep, cnt]) => ({ endpoint: ep, probes_24h: cnt }));

  // Recent paid (last 20)
  const recentPaid = [...paid24h]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20)
    .map(c => ({ timestamp: c.ts.toISOString(), ip: c.ip, endpoint: c.path, method: c.method }));

  return {
    summary: {
      paid_calls_1h: paid1h.length,
      paid_calls_24h: paid24h.length,
      unique_payers: uniqueIPs.size,
      est_revenue_usd: parseFloat((paid24h.length * 0.002).toFixed(4))
    },
    top_endpoints: topEndpoints,
    paying_agents: payingAgents,
    demand_signals: demandSignals,
    recent_paid: recentPaid
  };
}

router.get('/stats', async (req, res) => {
  const { key } = req.query;
  if (!key || key !== process.env.DASHBOARD_KEY) {
    return res.status(401).json({ error: 'Invalid key' });
  }
  const lines = readLogs();
  const stats = buildStats(lines, Date.now());

  // Add on-chain data via Alchemy
  try {
    const ALCHEMY = process.env.ALCHEMY_API_KEY;
    if (ALCHEMY) {
      const { data: alchData } = await axios.post(
        `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY}`,
        { id:1, jsonrpc:'2.0', method:'alchemy_getAssetTransfers', params:[{
          toAddress: '0x24FAcafEB49b4e3FACF0B3e69604A2F4640c9bf2',
          contractAddresses: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
          category: ['erc20'], withMetadata: true, maxCount: '0x64', order: 'desc'
        }]},
        { timeout: 10000 }
      );
      const txs = alchData.result?.transfers || [];
      const totalUsdc = txs.reduce((s,t) => s + parseFloat(t.value||0), 0);
      stats.onchain = {
        total_usdc: Math.round(totalUsdc * 10000) / 10000,
        tx_count: txs.length,
        unique_payers: [...new Set(txs.map(t=>t.from))].length,
        recent: txs.slice(0,5).map(t => ({
          amount: parseFloat(t.value),
          from: t.from?.substring(0,14)+'...',
          date: t.metadata?.blockTimestamp?.substring(0,10)
        }))
      };
    }
  } catch(e) { stats.onchain = { error: e.message }; }

  res.json(stats);
});

module.exports = router;
