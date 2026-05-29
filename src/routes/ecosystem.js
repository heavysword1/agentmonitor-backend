const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const router = express.Router();

const cache = new NodeCache({ stdTTL: 3600 });

const OUR_DOMAIN = 'memoryapi.org';
const AGENTIC_MARKET_URL = 'https://agentic.market/v1/services';

async function getEcosystem(category, sort) {
  const cacheKey = `ecosystem_${category || 'all'}_${sort || 'count'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let services = [];
  try {
    const { data } = await axios.get(AGENTIC_MARKET_URL, { timeout: 15000 });
    services = Array.isArray(data) ? data : (data.services || data.results || []);
  } catch (e) {
    // Return partial result if fetch fails
    services = [];
  }

  // Count by category
  const byCategory = {};
  const ourServices = [];

  for (const svc of services) {
    // Determine category
    const cat = (svc.category || svc.type || 'unknown').toLowerCase();

    // Apply category filter
    if (category && category !== 'all') {
      if (!cat.includes(category)) continue;
    }

    if (!byCategory[cat]) byCategory[cat] = { count: 0, services: [] };
    byCategory[cat].count++;
    byCategory[cat].services.push({
      name: svc.name || svc.id,
      url: svc.url || svc.endpoint,
      description: svc.description
    });

    // Check if it's ours
    const url = (svc.url || svc.endpoint || '');
    if (url.includes(OUR_DOMAIN)) {
      ourServices.push({ name: svc.name || svc.id, url, category: cat, description: svc.description });
    }
  }

  // Sort
  let sortedCategories;
  if (sort === 'alphabetical') {
    sortedCategories = Object.entries(byCategory)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
  } else {
    sortedCategories = Object.entries(byCategory)
      .sort((a, b) => b[1].count - a[1].count)
      .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
  }

  const result = {
    success: true,
    total_services: services.length,
    category_filter: category || 'all',
    by_category: sortedCategories,
    our_services: ourServices,
    source: 'Agentic Market'
  };

  cache.set(cacheKey, result);
  return result;
}

router.get('/', async (req, res) => {
  try {
    const { category = 'all', sort = 'count' } = req.query;
    const result = await getEcosystem(category, sort);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
