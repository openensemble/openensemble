import { requireAuth, readBody, isUserTimeBlocked, getAgentsForUser, loadConfig } from './_helpers.mjs';
import { getProjectSpace } from '../lib/project-spaces.mjs';
import { getBudgetSettings, setBudgetSettings, getProjectBudget, setProjectBudget, getBudgetRun, listBudgetRuns,
  setRunBudget, estimateBudgetRequest, acceptBudgetUsageEstimate } from '../lib/run-budgets.mjs';
import { continueBudgetRun, stopBudgetWork } from '../lib/run-budget-continuation.mjs';

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/run-budgets/')) return false;
  const userId = requireAuth(req, res, { allowMediaToken: false });
  if (!userId) return true;
  const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    if (isUserTimeBlocked(userId)) throw Object.assign(new Error('Account access is currently restricted.'), { status: 403 });
    const parts = url.pathname.slice('/api/run-budgets/'.length).split('/').map(decodeURIComponent);
    const input = ['POST', 'PATCH'].includes(req.method) ? JSON.parse(await readBody(req)) : null;
    if (['POST', 'PATCH'].includes(req.method) && (!input || typeof input !== 'object' || Array.isArray(input))) {
      throw Object.assign(new Error('Send a budget settings object.'), { status: 400 });
    }
    let data;
    if (parts[0] === 'settings' && parts.length === 1) {
      if (req.method === 'GET') data = getBudgetSettings(userId);
      else if (req.method === 'PATCH') data = setBudgetSettings(userId, input);
    } else if (parts[0] === 'projects' && parts.length === 2) {
      getProjectSpace(userId, parts[1]);
      if (req.method === 'GET') data = getProjectBudget(userId, parts[1]);
      else if (req.method === 'PATCH') data = setProjectBudget(userId, parts[1], input);
    } else if (parts[0] === 'runs') {
      if (parts.length === 1 && req.method === 'GET') data = { runs: listBudgetRuns(userId) };
      if (parts.length === 2 && req.method === 'GET') data = getBudgetRun(userId, parts[1]);
      if (parts.length === 2 && req.method === 'PATCH') data = setRunBudget(userId, parts[1], input);
      if (parts.length === 3 && parts[2] === 'authorize' && req.method === 'POST') data = await continueBudgetRun(userId, parts[1], input);
      if (parts.length === 3 && parts[2] === 'stop' && req.method === 'POST') data = await stopBudgetWork(userId, parts[1], input?.spanId);
      if (parts.length === 3 && parts[2] === 'settle' && req.method === 'POST') data = acceptBudgetUsageEstimate(userId, parts[1], input);
    } else if (parts[0] === 'estimate' && parts.length === 1 && req.method === 'POST') {
      const agent = getAgentsForUser(userId).find(item => item.id === input.agentId);
      if (!agent) throw Object.assign(new Error('Agent not found.'), { status: 404 });
      if (typeof input.text !== 'string' || input.text.length > 64000) throw Object.assign(new Error('Enter up to 64,000 characters to estimate.'), { status: 400 });
      data = estimateBudgetRequest({ provider: agent.provider, model: agent.model,
        request: { messages: [{ role: 'user', content: input.text }], system: agent.systemPrompt || '', tools: agent.tools || [] },
        outputTokens: agent.maxTokens || 4096, config: loadConfig() });
      data.note = 'Estimate for one request before chat history and runtime context are added. Delegates and later requests add usage; the total workflow cannot be predicted exactly.';
      data.outputCapSupported = agent.provider !== 'openai-oauth';
    }
    if (data === undefined) reply(405, { error: 'Unsupported budget operation.' });
    else reply(200, data);
  } catch (error) {
    const status = error.status || (error instanceof SyntaxError || error instanceof URIError ? 400 : 500);
    reply(status, { error: status < 500 ? error.message : 'Budget storage is unavailable. No new allowance was authorized.' });
  }
  return true;
}
