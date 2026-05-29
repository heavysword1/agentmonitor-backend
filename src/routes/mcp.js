const express = require('express');
const fs = require('fs');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();

const activityRouter = require('./activity');
const ecosystemRouter = require('./ecosystem');

// Reuse logic inline for MCP tool execution
const NodeCacheMCP = require('node-cache');
const mcpCache = new NodeCacheMCP({ stdTTL: 300 });

const LOG_PATH = '/var/log/nginx/access.log';
const LOG_REGEX = /^(\S+) - - \[([^\]]+)\] "(\w+) ([^ ]+) [^"]*" (\d+) \d+/;
const EXCLUDE_TERMS = ['bazaar-settle', 'settle-memory', 'agent_id=bazaar'];

function parseNginxTime(timeStr) {
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

const TOOLS = [
  {
    name: 'get_x402_activity',
    description: 'Get x402 paid API call activity stats from memoryapi.org nginx logs. Returns top endpoints by paid calls, unique payers, and trend data.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Lookback window in hours (1-168, default 24)', default: 24 },
        service: { type: 'string', description: 'Filter by service name (e.g. clinical, bio, research). Omit for all.' }
      }
    }
  },
  {
    name: 'get_x402_ecosystem',
    description: 'Get x402 ecosystem intelligence from Agentic Market. Returns services by category, counts, and which memoryapi.org services are listed.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category: inference, data, or all (default all)', default: 'all' },
        sort: { type: 'string', description: 'Sort by: count (default) or alphabetical', default: 'count' }
      }
    }
  }
];

async function executeTool(name, args) {
  switch (name) {
    case 'get_x402_activity': {
      const hours = Math.max(1, Math.min(168, parseInt(args.hours) || 24));
      const service = args.service;
      const cacheKey = `mcp_activity_${hours}_${service || 'all'}`;
      const cached = mcpCache.get(cacheKey);
      if (cached) return cached;

      let lines;
      try { lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n'); } catch (e) { lines = []; }

      const now = Date.now();
      const cutoff = new Date(now - hours * 60 * 60 * 1000);
      const halfCutoff = new Date(now - (hours / 2) * 60 * 60 * 1000);
      const paidCalls = [];

      for (const line of lines) {
        if (!line.includes('/x402')) continue;
        if (EXCLUDE_TERMS.some(t => line.includes(t))) continue;
        const m = line.match(LOG_REGEX);
        if (!m) continue;
        const [, ip, timeStr, method, path, status] = m;
        if (status !== '200') continue;
        if (service && !path.includes(`/x402/${service}`)) continue;
        const ts = parseNginxTime(timeStr);
        if (!ts || ts < cutoff) continue;
        paidCalls.push({ ip, ts, path });
      }

      const epCount = {};
      const epFirst = {};
      const epSecond = {};
      for (const c of paidCalls) {
        const ep = c.path.split('?')[0];
        epCount[ep] = (epCount[ep] || 0) + 1;
        if (c.ts < halfCutoff) epFirst[ep] = (epFirst[ep] || 0) + 1;
        else epSecond[ep] = (epSecond[ep] || 0) + 1;
      }

      const topEndpoints = Object.entries(epCount)
        .sort((a, b) => b[1] - a[1]).slice(0, 20)
        .map(([ep, cnt]) => ({
          endpoint: ep, calls: cnt,
          trend: (epSecond[ep]||0) > (epFirst[ep]||0) ? 'up' : (epSecond[ep]||0) < (epFirst[ep]||0) ? 'down' : 'stable'
        }));

      const result = { success: true, period_hours: hours, service_filter: service || null, total_paid_calls: paidCalls.length, top_endpoints: topEndpoints, source: 'memoryapi.org nginx logs' };
      mcpCache.set(cacheKey, result);
      return result;
    }

    case 'get_x402_ecosystem': {
      const category = args.category || 'all';
      const sort = args.sort || 'count';
      const cacheKey = `mcp_ecosystem_${category}_${sort}`;
      const cached = mcpCache.get(cacheKey);
      if (cached) return cached;

      let services = [];
      try {
        const { data } = await axios.get('https://agentic.market/v1/services', { timeout: 15000 });
        services = Array.isArray(data) ? data : (data.services || data.results || []);
      } catch (e) { services = []; }

      const byCategory = {};
      const ourServices = [];
      for (const svc of services) {
        const cat = (svc.category || svc.type || 'unknown').toLowerCase();
        if (category !== 'all' && !cat.includes(category)) continue;
        if (!byCategory[cat]) byCategory[cat] = { count: 0 };
        byCategory[cat].count++;
        const url = svc.url || svc.endpoint || '';
        if (url.includes('memoryapi.org')) ourServices.push({ name: svc.name || svc.id, url, category: cat });
      }

      const sortedCategories = Object.entries(byCategory)
        .sort(sort === 'alphabetical' ? (a, b) => a[0].localeCompare(b[0]) : (a, b) => b[1].count - a[1].count)
        .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

      const result = { success: true, total_services: services.length, category_filter: category, by_category: sortedCategories, our_services: ourServices, source: 'Agentic Market' };
      mcpCache.set(cacheKey, result);
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

router.get('/', (req, res) => {
  res.json({ name: 'AgentMonitor', version: '1.0.0', transport: 'http', protocol: 'mcp', tools: TOOLS.map(t => t.name) });
});

router.post('/', async (req, res) => {
  const { method, params, id } = req.body;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'AgentMonitor', version: '1.0.0' } };
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call': {
        const { name, arguments: args = {} } = params;
        const toolResult = await executeTool(name, args);
        result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] };
        break;
      }
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
    res.json({ jsonrpc: '2.0', id, result });
  } catch (err) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
  }
});

module.exports = router;
