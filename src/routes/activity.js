const express = require('express');
const fs = require('fs');
const NodeCache = require('node-cache');
const router = express.Router();

const cache = new NodeCache({ stdTTL: 300 });

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

function getActivity(hours, service) {
  hours = Math.max(1, Math.min(168, parseInt(hours) || 24));
  const cacheKey = `activity_${hours}_${service || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let lines;
  try {
    lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
  } catch (e) {
    lines = [];
  }

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
    if (method !== 'GET' && method !== 'POST') continue;

    if (service && !path.includes(`/x402/${service}`)) continue;

    const ts = parseNginxTime(timeStr);
    if (!ts || ts < cutoff) continue;

    paidCalls.push({ ip, ts, method, path });
  }

  const epCount = {};
  const epCountFirst = {};
  const epCountSecond = {};

  for (const c of paidCalls) {
    const ep = c.path.split('?')[0];
    epCount[ep] = (epCount[ep] || 0) + 1;
    if (c.ts < halfCutoff) {
      epCountFirst[ep] = (epCountFirst[ep] || 0) + 1;
    } else {
      epCountSecond[ep] = (epCountSecond[ep] || 0) + 1;
    }
  }

  const topEndpoints = Object.entries(epCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ep, cnt]) => {
      const first = epCountFirst[ep] || 0;
      const second = epCountSecond[ep] || 0;
      const trend = second > first ? 'up' : second < first ? 'down' : 'stable';
      return { endpoint: ep, calls: cnt, trend };
    });

  const result = {
    success: true,
    period_hours: hours,
    service_filter: service || null,
    total_paid_calls: paidCalls.length,
    top_endpoints: topEndpoints,
    source: 'memoryapi.org nginx logs'
  };

  cache.set(cacheKey, result);
  return result;
}

router.get('/', (req, res) => {
  try {
    const { hours = 24, service } = req.query;
    const result = getActivity(hours, service);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
