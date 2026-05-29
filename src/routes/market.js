const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();
const cache = new NodeCache({ stdTTL: 300 });

const OUR_WALLET = '0x24FAcafEB49b4e3FACF0B3e69604A2F4640c9bf2';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

router.get('/', async (req, res) => {
  try {
    const cacheKey = 'market:v2';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = {
      success: true,
      generated_at: new Date().toISOString(),
      our_portfolio: {},
      market: {}
    };

    // Agentic Market stats
    try {
      const { data } = await axios.get('https://api.agentic.market/v1/services?limit=1000', { timeout: 15000 });
      const services = data.services || [];
      const categoryMap = {};
      services.forEach(s => {
        const c = s.category || 'Uncategorized';
        categoryMap[c] = (categoryMap[c] || 0) + 1;
      });

      // Find our services
      const ourServices = services.filter(s =>
        JSON.stringify(s).toLowerCase().includes('memoryapi') ||
        JSON.stringify(s).toLowerCase().includes('ocean digital') ||
        (s.endpoints || []).some(e => (e.url || '').includes('memoryapi.org'))
      );

      result.market = {
        total_services: data.total || services.length,
        fetched: services.length,
        by_category: Object.fromEntries(Object.entries(categoryMap).sort((a,b) => b[1]-a[1])),
        our_services_found: ourServices.length,
        our_services: ourServices.map(s => ({ name: s.name, category: s.category, endpoints: (s.endpoints||[]).length })),
        top_services: services.slice(0,10).map(s => ({ name: s.name, category: s.category, endpoints: (s.endpoints||[]).length }))
      };
    } catch(err) {
      result.market.error = err.message;
    }

    // Our portfolio stats from nginx logs
    try {
      const fs = require('fs');
      const logs = [];
      try { logs.push(...fs.readFileSync('/var/log/nginx/access.log','utf8').split('\n')); } catch(e){}
      try { logs.push(...fs.readFileSync('/var/log/nginx/access.log.1','utf8').split('\n')); } catch(e){}

      const paid = logs.filter(l =>
        (l.includes('GET /x402') || l.includes('POST /x402')) &&
        l.includes(' 200 ') &&
        !l.includes('bazaar-settle') && !l.includes('settle-memory') && !l.includes('agent_id=bazaar')
      );

      const endpointCounts = {};
      const payers = new Set();
      paid.forEach(line => {
        const m = line.match(/"(?:GET|POST) (\/x402[^\s?]+)/);
        const ip = line.split(' ')[0];
        if (m) endpointCounts[m[1]] = (endpointCounts[m[1]] || 0) + 1;
        if (ip && ip !== '-') payers.add(ip);
      });

      result.our_portfolio = {
        total_paid_calls: paid.length,
        unique_payers: payers.size,
        est_revenue_usd: Math.round(paid.length * 0.002 * 1000) / 1000,
        top_endpoints: Object.entries(endpointCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([e,c])=>({endpoint:e,calls:c})),
        wallet: OUR_WALLET,
        note: 'On-chain transaction history: add BASESCAN_API_KEY to .env'
      };
    } catch(err) {
      result.our_portfolio.error = err.message;
    }

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
