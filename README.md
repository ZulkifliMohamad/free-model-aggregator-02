# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/ZulkifliMohamad/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/ZulkifliMohamad/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server that aggregates the best live free models behind a single OpenAI- and
Anthropic-compatible API. Every completion it answers comes from a real free model
dialled through the grader's gateway on OpenRouter — it never answers a prompt itself.

## Run it

```sh
node main.ts
```

`node main.ts --list` prints the catalog document and exits 0.

## How it works

- `POST /v1/chat/completions` answers OpenAI-shaped requests, `POST /v1/messages`
  answers Anthropic-shaped ones, in JSON and in streaming (SSE).
- `GET /v1/models` answers in the shape of the auth header it got: `Authorization:
  Bearer` gets the OpenAI list, `x-api-key` the Anthropic one.
- Routing is by the brief's published ratings: JSON-mode prompts go to the best
  JSON-capable free model (NVIDIA Nemotron 3.5 Super VL, 1303), everything else to the
  best free model overall (Thinking Machines Inkling 2 Small, 1475). Failover walks the
  same rating order, one retry of the primary on a 429/5xx first, and a model that
  refuses twice in a trial is demoted for the prompts that follow.
- Streams are buffered whole before anything is answered, so a broken or empty
  upstream stream fails over instead of serving a stream that fails every wire check.
  The emitted stream always ends with exactly one finish chunk, its usage chunk, then
  `[DONE]` (OpenAI) or `message_delta` + `message_stop` (Anthropic).
- A recovered refusal is reported on the response as
  `x-makefun-upstream-failures`, so the failover column can see it.
- The server registers its port and catalog with the env at
  `$MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/work` and exits 0
  when the env says done. Every choice is a function of the brief, the requests, and
  the gateway's answers — no wall clock, no unseeded randomness — so a replayed trial
  leaves the same state.

## Layout

```text
main.ts            the server: routing, failover, both wires, register and poll
lib/providers.ts   the brief's parser, the catalog, rating-ordered candidates
lib/wire.ts        Anthropic <-> Chat Completions translation and SSE writers
scripts/smoke-test.mjs   local mock env + gateway trial (no real models, no key)
```

`scripts/smoke-test.mjs` runs the six practice-trial prompts against a mock env and
a mock gateway and checks every wire rule the scorer checks:

```sh
node scripts/smoke-test.mjs
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6ksyay6h&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
