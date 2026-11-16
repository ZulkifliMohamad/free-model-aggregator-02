// Local smoke test: a mock env and a mock gateway drive the entry through the six
// practice-trial prompts (trial-0) and check every wire rule the scorer checks.
// No real model, no key, no network beyond loopback.
//
//   node scripts/smoke-test.mjs [prompt.txt] [workload.json]
//
// The mock gateway scripts two refusals on purpose:
//   - inkling-2-small answers its first call with 429, then succeeds (retry path);
//   - nemotron-3.5-super-vl answers every call with 500 (failover path for JSON).
// Expected outcome: p01/p04 fail over to gemma-4-31b after super-vl 500s twice
// (primary + its one retry), p02 retries inkling, 11 gateway calls in total, every
// prompt valid, the server exits 0 when the env says done.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KIT = '/home/hatch/workspace/makefun/free-model-aggregator-02-kit';
const PROMPT_FILE = process.argv[2] ?? join(KIT, 'practice/trial-0/input/prompt.txt');
const WORKLOAD_FILE = process.argv[3] ?? join(KIT, 'practice/trial-0/input/env/workload.json');
const ENV_PORT = Number(process.env.SMOKE_ENV_PORT ?? 18273);
const GATEWAY_PORT = Number(process.env.SMOKE_GATEWAY_PORT ?? 18274);

const EXPECTED_IDS = [
  'openrouter/baidu/ernie-5.5-flash-preview:free',
  'openrouter/cohere/north-mini-code:free',
  'openrouter/dots-studio/dots-3-note-preview:free',
  'openrouter/google/gemma-4-26b-a4b-it:free',
  'openrouter/google/gemma-4-31b-it:free',
  'openrouter/inclusionai/ling-3.2-flash:free',
  'openrouter/liquid/lfm-3-1.7b:free',
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  'openrouter/nvidia/nemotron-3.5-lightning:free',
  'openrouter/nvidia/nemotron-3.5-super-vl:free',
  'openrouter/particle-ai/particle-1:free',
  'openrouter/recursive/flint-v1.0:free',
  'openrouter/thinkingmachines/inkling-2-small:free',
];
const INKLING = 'openrouter/thinkingmachines/inkling-2-small:free';
const SUPER_VL = 'openrouter/nvidia/nemotron-3.5-super-vl:free';
const GEMMA_31B = 'openrouter/google/gemma-4-31b-it:free';

const workload = JSON.parse(readFileSync(WORKLOAD_FILE, 'utf8'));
const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}
function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}
function tokenOf(body) {
  const text = JSON.stringify(body.messages ?? body);
  const m = text.match(/[A-Z]{3,12}-[0-9]{4}/);
  return m === null ? null : m[0];
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
function sendJson(res, status, value, extra = {}) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

/* ---------------- mock gateway ---------------- */
const gatewayCalls = [];
const callsPerModel = new Map();
const gateway = createServer(async (req, res) => {
  const text = await readBody(req);
  let body = {};
  try { body = JSON.parse(text); } catch { /* keep {} */ }
  const model = typeof body.model === 'string' ? body.model : '';
  const n = (callsPerModel.get(model) ?? 0) + 1;
  callsPerModel.set(model, n);
  const token = tokenOf(body) ?? 'TOKEN-0000';
  const bare = model.replace(/^openrouter\//, '');
  const isJson = body.response_format?.type === 'json_object';
  const answer = isJson ? JSON.stringify({ token }) : token;
  if (model === INKLING && n === 1) {
    gatewayCalls.push({ model, status: 429 });
    return sendJson(res, 429, { error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit_exceeded' } });
  }
  if (model === SUPER_VL) {
    gatewayCalls.push({ model, status: 500 });
    return sendJson(res, 500, { error: { message: 'upstream boom', type: 'server_error', code: 'server_error' } });
  }
  gatewayCalls.push({ model, status: 200 });
  if (body.stream === true) {
    const head = answer.slice(0, Math.ceil(answer.length / 2));
    const tail = answer.slice(head.length);
    const frames = [
      `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: bare, choices: [{ index: 0, delta: { role: 'assistant', content: head }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: bare, choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: bare, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model: bare, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(frames.join(''));
    return;
  }
  return sendJson(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1700000000,
    model: bare,
    choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
});

/* ---------------- mock env ---------------- */
let registered = null;
let done = false;
const env = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/register') {
    registered = JSON.parse(await readBody(req));
    return sendJson(res, 200, { ok: true, requests: 6 });
  }
  if (req.method === 'GET' && req.url === '/work') {
    return sendJson(res, 200, done ? { done: true } : { done: false, next: 'p01', pending: 6 });
  }
  return sendJson(res, 404, { error: 'not found' });
});

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}
function runNode(args, envVars) {
  return new Promise((resolve) => {
    const child = spawn('node', args, { cwd: ROOT, env: { ...process.env, ...envVars }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
function parseSse(text) {
  const frames = [];
  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
    if (frame.trim() === '') continue;
    let event = null;
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return frames;
}

const LEGAL_OPENAI_STOP = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
const LEGAL_ANTHROPIC_STOP = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal', 'pause_turn']);

async function main() {
  await listen(gateway, GATEWAY_PORT);
  await listen(env, ENV_PORT);

  // --list prints the catalog and exits 0.
  const list = await runNode(['main.ts', '--list'], { MAKEFUN_PROMPT_FILE: PROMPT_FILE });
  check('--list exits 0', list.code === 0, `code ${list.code}: ${list.err.slice(0, 200)}`);
  let listCatalog = null;
  try { listCatalog = JSON.parse(list.out); } catch { /* stays null */ }
  check('--list prints one JSON catalog', listCatalog !== null);
  const listIds = listCatalog?.providers?.[0]?.models?.map((m) => m.id) ?? [];
  check('--list names exactly the 14 free ids', sameSet(listIds, EXPECTED_IDS), listIds.join(','));

  // Start the entry.
  const entryEnv = {
    MAKEFUN_PROMPT_FILE: PROMPT_FILE,
    MAKEFUN_ENV_URL: `http://127.0.0.1:${ENV_PORT}`,
    OPENAI_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}/v1`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    OPENAI_API_KEY: 'makefun-trial-test',
    ANTHROPIC_API_KEY: 'makefun-trial-test',
  };
  const child = spawn('node', ['main.ts'], { cwd: ROOT, env: { ...process.env, ...entryEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let entryErr = '';
  child.stderr.on('data', (d) => { entryErr += d; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  await waitFor(() => registered !== null, 10000, 'register');
  check('register carries the catalog byte-for-byte as --list', JSON.stringify(registered.catalog) === JSON.stringify(listCatalog));
  check('register protocol_version is 1', registered.protocol_version === 1);

  // The env asks GET /v1/models twice, once per auth header.
  const port = registered.port;
  const openaiList = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: 'Bearer x' } })).json();
  const anthropicList = await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { 'x-api-key': 'x', 'anthropic-version': '2023-06-01' } })).json();
  check('GET /v1/models (Bearer) lists exactly the 14 ids', sameSet(openaiList.data.map((m) => m.id), EXPECTED_IDS));
  check('GET /v1/models (x-api-key) lists exactly the 14 ids', sameSet(anthropicList.data.map((m) => m.id), EXPECTED_IDS));
  check('GET /v1/models (Bearer) is the OpenAI shape', openaiList.object === 'list' && openaiList.data[0].object === 'model');
  check('GET /v1/models (x-api-key) is the Anthropic shape', anthropicList.data[0].type === 'model' && anthropicList.has_more === false);

  const expectedModel = { p01: GEMMA_31B, p02: INKLING, p03: INKLING, p04: GEMMA_31B, p05: INKLING, p06: INKLING };
  for (const prompt of workload.manifest) {
    const body = workload.bodies[prompt.id];
    const token = prompt.token;
    const path = prompt.api === 'openai' ? '/v1/chat/completions' : '/v1/messages';
    const headers = { 'content-type': 'application/json' };
    if (prompt.api === 'openai') headers.authorization = 'Bearer x';
    else { headers['x-api-key'] = 'x'; headers['anthropic-version'] = '2023-06-01'; }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const trail = res.headers.get('x-makefun-upstream-failures');
    const text = await res.text();
    const label = `${prompt.id} (${prompt.api}${prompt.stream ? ', stream' : ''})`;
    check(`${label} answers HTTP 200`, res.status === 200, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (res.status !== 200) continue;
    if (prompt.api === 'openai' && !prompt.stream) {
      const value = JSON.parse(text);
      const message = value.choices?.[0]?.message ?? {};
      check(`${label} model is ${expectedModel[prompt.id]}`, value.model === expectedModel[prompt.id], `got ${value.model}`);
      check(`${label} text carries the token`, typeof message.content === 'string' && message.content.includes(token));
      check(`${label} usage is whole (input >= 0, output >= 1)`, value.usage?.prompt_tokens >= 0 && value.usage?.completion_tokens >= 1, JSON.stringify(value.usage));
      check(`${label} stop reason is legal`, LEGAL_OPENAI_STOP.has(value.choices?.[0]?.finish_reason), String(value.choices?.[0]?.finish_reason));
    } else if (prompt.api === 'openai' && prompt.stream) {
      const frames = parseSse(text);
      let joined = '';
      let finish = 0;
      let usage = null;
      let modelsOk = true;
      for (const frame of frames) {
        if (frame.data === '[DONE]') continue;
        const chunk = JSON.parse(frame.data);
        if (chunk.model !== expectedModel[prompt.id]) modelsOk = false;
        if (Array.isArray(chunk.choices) && chunk.choices[0]?.delta?.content) joined += chunk.choices[0].delta.content;
        if (chunk.choices?.[0]?.finish_reason) finish += 1;
        if (chunk.usage) usage = chunk.usage;
      }
      check(`${label} ends with [DONE]`, frames.length > 0 && frames[frames.length - 1].data === '[DONE]');
      check(`${label} carries exactly one finish chunk`, finish === 1, `saw ${finish}`);
      check(`${label} every chunk names ${expectedModel[prompt.id]}`, modelsOk);
      check(`${label} text carries the token`, joined.includes(token), JSON.stringify(joined));
      check(`${label} usage chunk is whole`, usage !== null && usage.prompt_tokens >= 0 && usage.completion_tokens >= 1, JSON.stringify(usage));
    } else if (prompt.api === 'anthropic' && !prompt.stream) {
      const value = JSON.parse(text);
      const joined = (value.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      check(`${label} model is ${expectedModel[prompt.id]}`, value.model === expectedModel[prompt.id], `got ${value.model}`);
      check(`${label} is a message with text carrying the token`, value.type === 'message' && joined.includes(token), JSON.stringify(joined));
      check(`${label} usage is whole (input >= 0, output >= 1)`, value.usage?.input_tokens >= 0 && value.usage?.output_tokens >= 1, JSON.stringify(value.usage));
      check(`${label} stop reason is legal`, LEGAL_ANTHROPIC_STOP.has(value.stop_reason), String(value.stop_reason));
      if (prompt.requires.tools === true) {
        const names = (value.content ?? []).filter((b) => b.type === 'tool_use').map((b) => b.name);
        check(`${label} names no undeclared tool`, names.every((n) => n === 'lookup_account'), names.join(','));
      }
    } else {
      const frames = parseSse(text);
      const events = frames.map((f) => f.event);
      check(`${label} event order is message_start..message_stop`, events[0] === 'message_start' && events[events.length - 1] === 'message_stop', events.join(','));
      const start = JSON.parse(frames[0].data);
      check(`${label} message_start names ${expectedModel[prompt.id]}`, start.message?.model === expectedModel[prompt.id], String(start.message?.model));
      let joined = '';
      let outputTokens = null;
      let stopReason = null;
      for (const frame of frames) {
        const data = JSON.parse(frame.data);
        if (frame.event === 'content_block_delta' && data.delta?.type === 'text_delta') joined += data.delta.text;
        if (frame.event === 'message_delta') { outputTokens = data.usage?.output_tokens ?? null; stopReason = data.delta?.stop_reason ?? null; }
      }
      check(`${label} text carries the token`, joined.includes(token), JSON.stringify(joined));
      check(`${label} message_delta usage output >= 1`, typeof outputTokens === 'number' && outputTokens >= 1, String(outputTokens));
      check(`${label} stop reason is legal`, LEGAL_ANTHROPIC_STOP.has(stopReason), String(stopReason));
    }
    if (prompt.id === 'p01' || prompt.id === 'p04') {
      // super-vl 500s twice (primary + its one retry), then gemma-4-31b serves: 2 trail rows.
      const rows = trail === null ? null : JSON.parse(trail);
      check(`${label} reports its failover in x-makefun-upstream-failures`, rows !== null && rows.length === 2 && rows.every((r) => r.status === 500 && r.model === SUPER_VL), String(trail));
    }
    if (prompt.id === 'p02') {
      check(`${label} reports its retried 429 in x-makefun-upstream-failures`, trail !== null && JSON.parse(trail).length === 1 && JSON.parse(trail)[0].status === 429, String(trail));
    }
  }

  check('gateway saw exactly 11 calls (6 prompts + 5 recovered refusals)', gatewayCalls.length === 11, `${gatewayCalls.length}: ${JSON.stringify(gatewayCalls)}`);
  check('gateway saw no call for a model outside the fourteen', gatewayCalls.every((c) => EXPECTED_IDS.includes(c.model)));

  done = true;
  let timer;
  const code = await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => r('timeout'), 10000); })]);
  clearTimeout(timer);
  check('server exits 0 when the env says done', code === 0, `exit ${code}; stderr: ${entryErr.slice(0, 500)}`);

  gateway.close();
  env.close();
  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
}

main().catch((err) => {
  console.error(`FAIL smoke harness: ${err.stack ?? err}`);
  process.exit(1);
});
