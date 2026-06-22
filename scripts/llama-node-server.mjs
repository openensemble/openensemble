#!/usr/bin/env node
/**
 * llama-node-server.mjs — a tiny OpenAI-compatible HTTP server around
 * node-llama-cpp, used to run OE's cortex (reason) and plan (scheduler/extract)
 * GGUF models on a SPECIFIC GPU, in their OWN process.
 *
 * Why this instead of llama.cpp's `llama-server`: building llama-server with
 * Vulkan from source needs the Vulkan SDK (glslc + headers → sudo apt), but
 * node-llama-cpp already ships a working Vulkan prebuilt. Running it in a
 * separate process lets each model be pinned to a different GPU via
 * GGML_VK_VISIBLE_DEVICES (node-llama-cpp honors it — verified), exactly like
 * the faster-whisper STT service. The systemd `--user` unit sets the env +
 * launches this; OE talks to it over the OpenAI /v1/chat/completions API,
 * reusing its existing lmstudio provider path.
 *
 * Env (set by the systemd unit):
 *   OE_LLAMA_MODEL   absolute path to the .gguf                (required)
 *   OE_LLAMA_PORT    listen port on 127.0.0.1                  (default 5155)
 *   OE_LLAMA_GPU     'vulkan' | 'cuda' | 'false'               (default 'vulkan')
 *   OE_LLAMA_CTX     context size                              (default 4096)
 *   OE_LLAMA_NAME    model id reported by /v1/models           (default = filename)
 *   GGML_VK_VISIBLE_DEVICES  which Vulkan device(s) to use     (honored by ggml)
 *
 * Routes:
 *   GET  /health              → { ok, model, gpu, gpuDevices }
 *   GET  /v1/models           → { data: [{ id }] }
 *   POST /v1/chat/completions → OpenAI chat completion (non-streaming)
 */
import http from 'http';
import path from 'path';
import { getLlama, LlamaCompletion } from 'node-llama-cpp';

const MODEL_PATH = process.env.OE_LLAMA_MODEL;
const PORT       = parseInt(process.env.OE_LLAMA_PORT || '5155', 10);
const GPU_OPT    = (process.env.OE_LLAMA_GPU || 'vulkan').toLowerCase();
const CTX_SIZE   = parseInt(process.env.OE_LLAMA_CTX || '4096', 10);
const MODEL_NAME = process.env.OE_LLAMA_NAME || (MODEL_PATH ? path.basename(MODEL_PATH) : 'model');
const GPU        = GPU_OPT === 'false' || GPU_OPT === 'cpu' ? false : GPU_OPT;

if (!MODEL_PATH) { console.error('[llama-node-server] OE_LLAMA_MODEL is required'); process.exit(2); }

let _llama, _model, _context, _gpuDevices = [];

async function init() {
  _llama = await getLlama({ gpu: GPU });
  try { _gpuDevices = await _llama.getGpuDeviceNames(); } catch { _gpuDevices = []; }
  _model = await _llama.loadModel({ modelPath: MODEL_PATH, gpuLayers: GPU ? 'max' : 0 });
  _context = await _model.createContext({ contextSize: CTX_SIZE });
  console.log(`[llama-node-server] loaded ${MODEL_NAME} on gpu=${_llama.gpu} devices=${JSON.stringify(_gpuDevices)} port=${PORT}`);
}

// Serialize generations — one context, one at a time (matches the bundled
// plan model's serial queue; these models are tiny so throughput is fine).
let _queue = Promise.resolve();
function enqueue(fn) {
  const r = _queue.then(fn, fn);
  _queue = r.catch(() => {});
  return r;
}

// Build the ChatML prompt EXACTLY as scheduler/builtin-plan.mjs does, so the
// model sees the same format whether it runs in-process or here. system + user
// are concatenated from the OpenAI messages; the task token (if any) already
// rides inside the user content (the caller prepends it).
function buildPrompt(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content || '').join('\n');
  const user = messages.filter(m => m.role !== 'system').map(m => m.content || '').join('\n');
  return `<|im_start|>system\n${sys}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
}

async function generate({ messages, temperature, maxTokens }) {
  const prompt = buildPrompt(messages || []);
  const tokens = _model.tokenize(prompt, true);
  const sequence = _context.getSequence();
  try {
    const completion = new LlamaCompletion({ contextSequence: sequence });
    const out = await completion.generateCompletion(tokens, {
      maxTokens: maxTokens ?? 512,
      temperature: temperature ?? 0.01,
    });
    return typeof out === 'string' ? out.trim() : '';
  } finally {
    if (typeof sequence.dispose === 'function') sequence.dispose();
  }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return send(res, 200, { ok: true, model: MODEL_NAME, gpu: _llama?.gpu ?? false, gpuDevices: _gpuDevices });
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: MODEL_NAME, object: 'model' }] });
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      const text = await enqueue(() => generate({
        messages: body.messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
      }));
      return send(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        model: MODEL_NAME,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[llama-node-server] request error:', e.message);
    return send(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  console.error(`[llama-node-server] server error on port ${PORT}: ${e.code || e.message}` +
    (e.code === 'EADDRINUSE' ? ' (port already in use — pick a free OE_LLAMA_PORT)' : ''));
  process.exit(1);
});

init()
  .then(() => server.listen(PORT, '127.0.0.1', () => console.log(`[llama-node-server] listening on 127.0.0.1:${PORT}`)))
  .catch(e => { console.error('[llama-node-server] init failed:', e.message); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { server.close(); } catch {} process.exit(0); });
