require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { bazaarResourceServerExtension } = require('@x402/extensions');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { HTTPFacilitatorClient } = require('@x402/core/server');

const dashboardRouter = require('./routes/dashboard');
const activityRouter = require('./routes/activity');
const ecosystemRouter = require('./routes/ecosystem');
const marketRouter = require('./routes/market');
const mcpRouter = require('./routes/mcp');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3027;
const PAY_TO = process.env.PAY_TO_ADDRESS || '0x24FAcafEB49b4e3FACF0B3e69604A2F4640c9bf2';
const X402_NETWORK = process.env.X402_NETWORK || 'eip155:8453';
const FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://x402.org/facilitator';

// --- Static + Dashboard (before x402 middleware) ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));

// --- Health + Well-Known ---
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'agentmonitor', port: PORT }));
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({ resource: 'https://monitor.memoryapi.org/mcp', authorization_servers: [], bearer_methods_supported: [], resource_documentation: 'https://memoryapi.org' });
});
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.status(404).json({ error: 'No OAuth required.' });
});

// --- OpenAPI ---
app.get('/openapi.json', (req, res) => res.sendFile(path.join(__dirname, 'openapi.json')));

// --- Dashboard API (key-protected, no x402) ---
app.use('/api', dashboardRouter);

// --- MCP (no x402 on MCP endpoint) ---
app.use('/mcp', mcpRouter);

// --- x402 Payment Middleware ---
try {
  const { createFacilitatorConfig } = require('@coinbase/x402');
  const rawConfig = createFacilitatorConfig(process.env.CDP_API_KEY_NAME, process.env.CDP_API_KEY_PRIVATE_KEY);
  const facilitatorClient = new HTTPFacilitatorClient({ url: rawConfig.url, createAuthHeaders: rawConfig.createAuthHeaders });
  const x402Server = new x402ResourceServer(facilitatorClient)
    .register(X402_NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  app.use(paymentMiddleware(
    {
      'GET /x402/monitor/activity': {
        accepts: [{ scheme: 'exact', price: '$0.001', network: X402_NETWORK, payTo: PAY_TO }],
        description: 'x402 API activity stats — top endpoints by paid calls, trend data, and unique payer counts from memoryapi.org nginx logs.',
        extensions: { bazaar: { info: {
          description: 'Get x402 paid API call activity from memoryapi.org. Returns top endpoints, call counts, and trends.',
          input: { type: 'http', method: 'GET',
            queryParams: { hours: '24', service: 'clinical' },
            schema: { properties: {
              hours: { type: 'string', description: 'Lookback window in hours (1-168, default 24)' },
              service: { type: 'string', description: 'Filter by service name (e.g. clinical, bio, research)' }
            }, required: [] }
          },
          output: { example: { success: true, period_hours: 24, total_paid_calls: 142, top_endpoints: [{ endpoint: '/x402/clinical/study', calls: 87, trend: 'up' }], source: 'memoryapi.org nginx logs' } }
        }}}
      },

      'GET /x402/monitor/market': {
        accepts: [{ scheme: 'exact', price: '$0.005', network: X402_NETWORK, payTo: PAY_TO }],
        description: 'x402 market intelligence — on-chain transaction history, Agentic Market service counts by category, ecosystem trends.',
        extensions: { bazaar: { info: {
          description: 'x402 ecosystem market intelligence. On-chain USDC transaction data, Agentic Market service directory stats, and category breakdowns.',
          input: { type: 'http', method: 'GET', queryParams: {}, schema: { properties: {}, required: [] } },
          output: { example: { success: true, total_received_usdc: 2.15, unique_payers: 3, market_services: { total: 941, by_category: { Data: 45, Inference: 12 } } } }
        }}}
      },

      'GET /x402/monitor/ecosystem': {
        accepts: [{ scheme: 'exact', price: '$0.001', network: X402_NETWORK, payTo: PAY_TO }],
        description: 'x402 ecosystem intelligence — service counts by category from Agentic Market, with memoryapi.org listings highlighted.',
        extensions: { bazaar: { info: {
          description: 'Get x402 ecosystem intelligence from Agentic Market. Services by category, total counts, and memoryapi.org presence.',
          input: { type: 'http', method: 'GET',
            queryParams: { category: 'all', sort: 'count' },
            schema: { properties: {
              category: { type: 'string', description: 'Filter: inference, data, or all (default all)' },
              sort: { type: 'string', description: 'Sort by: count (default) or alphabetical' }
            }, required: [] }
          },
          output: { example: { success: true, total_services: 47, by_category: { data: { count: 12 }, inference: { count: 8 } }, our_services: [], source: 'Agentic Market' } }
        }}}
      }
    },
    x402Server,
    { afterSettle: (req, res, next, s) => { const e = s?.extensionResponses; if (e) console.log('[CDP] EXTENSION-RESPONSES:', JSON.stringify(e)); next(); } },
    null, true
  ));

  console.log('✅ x402 payment middleware registered');
} catch (err) {
  console.warn('⚠️  x402 middleware skipped:', err.message);
}

// --- x402 Route Handlers ---
app.use('/x402/monitor/activity', activityRouter);
app.use('/x402/monitor/market', marketRouter);
app.use('/x402/monitor/ecosystem', ecosystemRouter);

app.listen(PORT, () => console.log(`AgentMonitor running on port ${PORT}`));
