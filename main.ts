// free-model-aggregator-02: one server, two client wires, and a real free model behind
// every answer.
//
// The brief at $MAKEFUN_PROMPT_FILE lists fourteen free OpenRouter models with the house's
// quality rating each, and six prompts with the requirements a model must meet to serve them.
// Quality is 60% of the score and is the rating of the model that really served a prompt over
// the best rating meeting that prompt's requirements, so routing is the whole game:
//
//   - a JSON-mode prompt needs a model with json: true. The best of those is
//     openrouter/nvidia/nemotron-3.5-super-vl:free (1303); nothing better that takes JSON
//     exists, so it serves every JSON prompt.
//   - every other prompt (plain, streaming, tools) takes the best model overall,
//     openrouter/thinkingmachines/inkling-2-small:free (1475). It takes tools and vision
//     but not JSON mode, so it never serves a JSON prompt.
//   - failover walks the same rating order: gemma-4-31b (1210) after super-vl for JSON,
//     super-vl (1303), nemotron-3-ultra (1285), nemotron-3.5-lightning (1221) after inkling
//     otherwise. A model that refuses three times this trial is demoted below models that
//     have not (two refusals can be one prompt's primary plus its retry), but stays
//     available as a last resort.
//
// Every prompt is answered by dialling the gateway's Chat Completions route, including the
// Anthropic-shaped ones (translated there and back). Streams are buffered whole before
// anything is answered: a broken or empty upstream stream is caught while failover can
// still save the prompt, and the emitted stream is then well-formed by construction
// (exactly one finish chunk, its usage chunk, then [DONE] / message_stop).
//
// Determinism: no wall clock and no unseeded randomness reach any request. Retries and
// demotion depend only on the gateway's answers, which a replay serves back identically,
// and every emitted byte is a function of the client request and those answers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  freeModels,
  isRecord,
  rankedCandidates,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicStreamFromParsed,
  anthropicToOpenAI,
  fallbackUsage,
  openAIError,
  openAIJsonWithModel,
  openAIJsonWithUsage,
  openAIModelList,
  openAIStreamFromParsed,
  openAIToAnthropic,
  parseOpenAIStream,
  type ParsedCompletion,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The most upstream attempts one prompt costs (the tie-break counts gateway calls). */
const MAX_ATTEMPTS = 4;
/** A refused model is retried once, then the prompt fails over to the next candidate. */
const MAX_SAME_MODEL_ATTEMPTS = 2;
/** One gateway call may take this long before it counts as refused. */
const GATEWAY_TIMEOUT_MS = 20000;
/** Pause after a 429 before the next attempt, in milliseconds. */
const RETRY_AFTER_RATE_LIMIT_MS = 300;
/** Pause after a 5xx or a network failure before the next attempt, in milliseconds. */
const RETRY_AFTER_SERVER_ERROR_MS = 150;
/** Register attempts before the server gives up. */
const REGISTER_ATTEMPTS = 3;
/** Pause between register attempts, in milliseconds. */
const REGISTER_RETRY_MS = 500;
/** A model that refuses this many times in the trial is demoted for the prompts that follow. Three,
not two: a prompt retries its primary once, so two refusals can come from one transient spike in
one prompt, and demoting on those would make the next prompt skip a model that has recovered. */
const DEMOTE_AFTER_REFUSALS = 3;
/** The output cap a request gets when the client named none (the gateway refuses uncapped calls). */
const DEFAULT_MAX_TOKENS = 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Models that refused twice or more this trial, demoted for later prompts (never dropped). */
const demoted = new Set<string>();
/** Refusals per model this trial, the counter behind demotion. */
const refusalCounts = new Map<string, number>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/** The requirements of the prompt now arriving: the brief's row, unioned with the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  const fromBody = requirementsFromBody(body);
  const fromManifest = entry === undefined ? {} : entry.requires;
  return {
    ...(fromManifest.tools === true || fromBody.tools === true ? { tools: true } : {}),
    ...(fromManifest.vision === true || fromBody.vision === true ? { vision: true } : {}),
    ...(fromManifest.json === true || fromBody.json === true ? { json: true } : {}),
    ...(fromManifest.min_context !== undefined ? { min_context: fromManifest.min_context } : {}),
  };
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** Text the fallback usage estimate is measured from: the request, stringified whole. */
function requestText(body: Json): string {
  return JSON.stringify(body);
}

/** The text of a Chat Completions answer's first choice, or '' when it has none. */
function textOfAnswer(answer: Json): string {
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice !== null && isRecord(choice.message) ? choice.message : null;
  return message !== null && typeof message.content === 'string' ? message.content : '';
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function failuresHeader(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, 8)) };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, extraHeaders: Record<string, string> = {}): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), extraHeaders);
  else sendJson(res, status, openAIError(message, type, null), extraHeaders);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** One refused gateway call, as the response's `x-makefun-upstream-failures` trail reports it. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** The gateway error code of a refusal body, or '' when it names none. */
function errorCodeOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !isRecord(value.error)) return '';
    const code = value.error.code;
    if (typeof code === 'string' && code !== '') return code.slice(0, 64);
    const type = value.error.type;
    return typeof type === 'string' ? type.slice(0, 64) : '';
  } catch {
    return '';
  }
}

/** The id and created second the upstream stream's first chunk carried, for the emitted stream. */
function firstChunkMeta(raw: string): { id: string; created: number } {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk: unknown = JSON.parse(payload);
      if (!isRecord(chunk)) continue;
      return {
        id: typeof chunk.id === 'string' && chunk.id !== '' ? chunk.id : 'chatcmpl-aggregate',
        created: typeof chunk.created === 'number' && Number.isFinite(chunk.created) ? chunk.created : 0,
      };
    } catch {
      return { id: 'chatcmpl-aggregate', created: 0 };
    }
  }
  return { id: 'chatcmpl-aggregate', created: 0 };
}

/** A gateway call's outcome: either a usable answer, or the refusal that ended the attempt. */
type AttemptResult =
  | { ok: true; model: string; answer: Json; parsed: ParsedCompletion | null; rawStream: string; meta: { id: string; created: number } }
  | { ok: false; failure: FailureRow };

/**
 * One gateway call for one model. A stream is read whole and parsed before it counts as served:
 * an empty stream, a stream with no text and no tool call, or a JSON answer with no usable
 * message all count as refused here, so the caller can fail over before answering the client.
 * The answer's text is never altered: the token it carries is what the scorer proves with.
 */
async function attemptOnce(model: string, body: Json, stream: boolean): Promise<AttemptResult> {
  let upstream: Response;
  try {
    upstream = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}`, ...(stream ? { accept: 'text/event-stream' } : {}) },
      body: JSON.stringify({ ...body, model }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: { status: 502, code: 'upstream_error', model } };
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return { ok: false, failure: { status: upstream.status, code: errorCodeOf(text), model } };
  }
  if (stream) {
    const raw = await upstream.text().catch(() => '');
    const parsed = parseOpenAIStream(raw);
    if (parsed.frames === 0 || (parsed.text === '' && parsed.toolCalls.length === 0)) {
      return { ok: false, failure: { status: 502, code: 'empty_answer', model } };
    }
    return { ok: true, model, answer: {}, parsed, rawStream: raw, meta: firstChunkMeta(raw) };
  }
  const raw = await upstream.text().catch(() => '');
  let answer: unknown;
  try {
    answer = JSON.parse(raw);
  } catch {
    return { ok: false, failure: { status: 502, code: 'bad_upstream_answer', model } };
  }
  if (!isRecord(answer)) return { ok: false, failure: { status: 502, code: 'bad_upstream_answer', model } };
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  const message = choice !== null && isRecord(choice.message) ? choice.message : null;
  if (message === null || message.role !== 'assistant' || typeof choice?.finish_reason !== 'string') {
    return { ok: false, failure: { status: 502, code: 'bad_upstream_answer', model } };
  }
  const text = typeof message.content === 'string' ? message.content : '';
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (text === '' && calls.length === 0) {
    return { ok: false, failure: { status: 502, code: 'empty_answer', model } };
  }
  return { ok: true, model, answer, parsed: null, rawStream: '', meta: { id: 'chatcmpl-aggregate', created: 0 } };
}

/**
 * Serve one prompt: the best candidate first, one retry of it on a 429 or 5xx, then the next
 * candidates in rating order, at most MAX_ATTEMPTS gateway calls. A 401 gives up at once: with
 * no key pushed every model refuses the same way, and extra calls only cost the tie-break.
 * Every refusal is recorded against its model (twice demotes it for later prompts) and
 * returned as the trail the response reports, so a recovered prompt still counts as a
 * failover the scorer can see.
 */
async function serveWithFailover(
  baseBody: Json,
  stream: boolean,
  requires: Requirement,
): Promise<{ result: AttemptResult; failures: FailureRow[] }> {
  const candidates = rankedCandidates(brief, requires, demoted);
  const failures: FailureRow[] = [];
  const tried = new Map<string, number>();
  let lastModel: string | null = null;
  let lastStatus: number | null = null;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    let model: ModelRow | null = null;
    const primary = candidates[0] ?? null;
    if (
      primary !== null &&
      lastModel === primary.id &&
      (tried.get(primary.id) ?? 0) < MAX_SAME_MODEL_ATTEMPTS &&
      lastStatus !== null &&
      (lastStatus === 429 || lastStatus >= 500)
    ) {
      model = primary;
    } else {
      model = candidates.find((candidate) => !tried.has(candidate.id)) ?? null;
      if (model === null) break;
    }
    attempts += 1;
    tried.set(model.id, (tried.get(model.id) ?? 0) + 1);
    const result = await attemptOnce(model.id, baseBody, stream);
    if (result.ok) return { result, failures };
    failures.push(result.failure);
    refusalCounts.set(model.id, (refusalCounts.get(model.id) ?? 0) + 1);
    if ((refusalCounts.get(model.id) ?? 0) >= DEMOTE_AFTER_REFUSALS) demoted.add(model.id);
    lastModel = model.id;
    lastStatus = result.failure.status;
    log(`refused: ${model.id} HTTP ${result.failure.status} ${result.failure.code} (attempt ${attempts}/${MAX_ATTEMPTS})`);
    if (result.failure.status === 401) break;
    if (attempts < MAX_ATTEMPTS) {
      await sleep(result.failure.status === 429 ? RETRY_AFTER_RATE_LIMIT_MS : RETRY_AFTER_SERVER_ERROR_MS);
    }
  }
  return { result: { ok: false, failure: failures[failures.length - 1] ?? { status: 502, code: 'no_free_model', model: null } }, failures };
}

/** The Chat Completions body one attempt sends: the client's, with a model and an output cap. */
function gatewayBody(body: Json, stream: boolean): Json {
  const out: Json = { ...body };
  delete out.model;
  if (typeof out.max_tokens !== 'number' && typeof out.max_completion_tokens !== 'number') out.max_tokens = DEFAULT_MAX_TOKENS;
  if (stream && !isRecord(out.stream_options)) out.stream_options = { include_usage: true };
  return out;
}

/** A refused prompt as a 502 in the client's wire, carrying the failures trail when there is one. */
function refused(res: ServerResponse, wire: 'openai' | 'anthropic', failures: FailureRow[]): void {
  const last = failures[failures.length - 1];
  const status = last?.status ?? 502;
  const detail = last === undefined ? 'no free model could serve this prompt' : `the gateway answered HTTP ${status}${last.code === '' ? '' : ` (${last.code})`} and no free model could serve this prompt`;
  if (wire === 'anthropic') sendError(res, wire, 502, 'api_error', detail, failuresHeader(failures));
  else sendError(res, wire, 502, 'upstream_error', detail, failuresHeader(failures));
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const stream = body.stream === true;
  const reqText = requestText(body);
  const { result, failures } = await serveWithFailover(gatewayBody(body, stream), stream, requires);
  if (!result.ok) return refused(res, 'openai', failures);
  const headers = failuresHeader(failures);
  if (stream && result.parsed !== null) {
    const fallback = fallbackUsage(reqText, result.parsed.text);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for (const frame of openAIStreamFromParsed(result.parsed, result.model, result.meta.id, result.meta.created, fallback)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const withUsage = openAIJsonWithUsage(result.answer, fallbackUsage(reqText, textOfAnswer(result.answer)));
  sendJson(res, 200, openAIJsonWithModel(withUsage, result.model), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const stream = body.stream === true;
  const reqText = requestText(body);
  // The model is chosen before translation: the translated body must name it, and the
  // translation is a pure function of the client body, so the replay sees the same bytes.
  const candidates = rankedCandidates(brief, requires, demoted);
  const first = candidates[0] ?? null;
  if (first === null) return sendError(res, 'anthropic', 503, 'overloaded_error', 'no free model in the brief meets this request');
  const translated = anthropicToOpenAI(body, first.id);
  const { result, failures } = await serveWithFailover(gatewayBody(translated, stream), stream, requires);
  if (!result.ok) return refused(res, 'anthropic', failures);
  const headers = failuresHeader(failures);
  if (stream && result.parsed !== null) {
    const fallback = fallbackUsage(reqText, result.parsed.text);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      for (const event of anthropicStreamFromParsed(result.parsed, result.model, fallback)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const withUsage = openAIJsonWithUsage(result.answer, fallbackUsage(reqText, textOfAnswer(result.answer)));
  sendJson(res, 200, openAIToAnthropic(openAIJsonWithModel(withUsage, result.model), result.model), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const reply: unknown = await res.json();
      if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_RETRY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
