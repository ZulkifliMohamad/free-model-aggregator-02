# Build report — free-model-aggregator-02

Competition: The best live free-model aggregator (`free-model-aggregator-02`), $500 USDC.
Account: @steady-koala-56, payout wallet `4o4WqB3G7im2t3Y1FFzaeeKFJ9zVtWQHNy3HY6gQArwo`.
Deadline: 2026-11-17T03:30:00Z. Built 2026-11-16, local-only repo commit
`ad204f1962eebeb107093b62f839023ce1ec2641` (no remote, nothing pushed).

## What was built

One Node 22 server (no dependencies, standard library only) that aggregates the
fourteen free OpenRouter models behind one OpenAI- and Anthropic-compatible API.
Every completion comes from a real free model dialled through the grader's gateway;
the server never answers a prompt itself.

- Routing is by the brief's published ratings, so quality (60% of the score) is
  maximised when the models answer: JSON-mode prompts go to the best JSON-capable
  free model (NVIDIA Nemotron 3.5 Super VL, 1303); every other prompt goes to the
  best free model overall (Thinking Machines Inkling 2 Small, 1475).
- Failover walks the same rating order (gemma-4-31b 1210 after Super VL; Super VL
  1303, Nemotron 3 Ultra 1285, Nemotron 3.5 Lightning 1221 after Inkling): one
  retry of the primary on a 429/5xx, then the next candidate, at most 4 gateway
  calls per prompt. A 401 gives up at once (no key: every model refuses the same
  way). A model that refuses 3 times in a trial is demoted for later prompts but
  stays available as a last resort. Recovered refusals are reported on the
  response as `x-makefun-upstream-failures`, so the failover column can see them.
- Streams are buffered whole before anything is answered, so a broken or empty
  upstream stream fails over instead of serving a stream that fails every wire
  check. The emitted stream always ends with exactly one finish chunk, its usage
  chunk, then `[DONE]` (OpenAI) or `message_delta` + `message_stop` (Anthropic).
  Usage is relayed whole; only when the gateway omits usage entirely is a
  conservative estimate filled in (documented in `lib/wire.ts`).
- `GET /v1/models` answers in the shape of the auth header (Bearer: OpenAI list,
  `x-api-key`: Anthropic list), always exactly the fourteen ids. The catalog
  registered with the env is byte-for-byte the document `node main.ts --list`
  prints. The server polls `GET $MAKEFUN_ENV_URL/work` and exits 0 on done.
- No wall clock and no unseeded randomness reach any request, so a replayed trial
  sees the same requests.

## Files

```text
main.ts                  the server: routing, failover, both wires, register, poll
lib/providers.ts         brief parser, catalog, rating-ordered candidates
lib/wire.ts              Anthropic <-> Chat Completions translation, SSE writers
LICENSE                  MIT
README.md                badges, run instructions, layout (see note below)
.makefun/owner.json      claim file naming the payout wallet
.gitignore
scripts/smoke-test.mjs   local mock env + gateway trial (no real models, no key)
BUILD-REPORT.md          this file
```

## Check results

- Mock smoke test (`node scripts/smoke-test.mjs`): **48 PASS, 0 FAIL, ~3.4 s**.
  Drives all six practice-trial prompts through a mock env and mock gateway that
  scripts a 429 on Inkling (retry path) and a persistent 500 on Super VL
  (failover path). Verifies `--list`, register catalog byte equality, both
  `/v1/models` shapes, token/usage/stop-reason/model on every prompt, stream
  order on both wires, the failures header, exactly 11 gateway calls, and exit 0.
- Kit check (`node cli/makefun.mjs check --kit . --repo <this dir>`, from the kit):
  **6 passed, 1 failed, 14 skipped, 5 checked at submission. Exit 1.**
  Passed: competition open, snapshot within caps (8 files, 89,240 bytes),
  LICENSE MIT (OSI), entrypoint `main.ts` (node22), entry size, no committed
  provider key. Failed, as expected with no bundle yet: `transcripts_present`
  (no transcripts uploaded). The rest are transcript-gate skips or
  at-submission items (repo public / owner / created-after-open / commit pushed /
  not a duplicate).
- Real local grade (`grade-local --kit . --bot <this dir> --driver process
  --instances 1`, dummy provider key): the real env drove all six prompts, the
  entry registered, routed exactly as designed (Super VL, Inkling, Inkling,
  Super VL, Inkling, Inkling), made exactly one gateway call per prompt (401
  gives up at once), and exited 0 after 2.7 s. The trial was **voided**
  (upstream errors on 6/6 forwarded requests) because the dummy key is refused
  401 by OpenRouter — an infrastructure void, not an entry fault. Spend $0.
  No score is possible until a real OpenRouter key is pushed (see blockers).

## What still blocks submission

1. **No OpenRouter key pushed.** `secrets ls` reports none pushed for this
   competition, and no provider key exists in the environment. Without it every
   model call is refused 401, no prompt is served, and the entry is not ranked.
   Needs Feb: an OpenRouter account with at least 10 credits purchased, key
   pushed via `makefun secrets push free-model-aggregator-02 --env-file .env`
   (never commit the `.env`). Under 10 credits the 50/day free ceiling can run
   out mid-grade.
2. **No GitHub repository.** Per the task, no GitHub repo was created and nothing
   was submitted. Needs: create a public repo after the 2026-11-15T03:30:00Z
   opening, push this commit, set its About (homepage
   `https://make.fun/bounty/free-model-aggregator-02`, topic `makefun`), then
   submit with the kit CLI before 2026-11-17T03:30:00Z.
3. **README badges need the real owner.** `README.md` still carries the
   `{owner}` placeholder in the rank/reward badge URLs (the GitHub owner is not
   known until the repo is created). Replace `{owner}` with the repo owner
   before submitting, or the `repo_readme` check fails.
4. **Transcript bundle.** No bundle was made (the parent agent owns the session
   records). Before submitting, run `bundle` from the top-level agent once all
   subagents finish, then `check` again with `--transcripts` — it must pass the
   transcript gate. Note the gate's `thinking_fresh`/`thinking_in_window`
   requirements: sessions must fall inside the competition window (opened
   2026-11-15T03:30:00Z).
5. **Re-grade with a real key.** After the key is pushed, re-run `grade-local`
   (or the dev grade on submit) to confirm a non-zero score before the deadline;
   the mock test cannot prove the real models return the tokens.

## Notes

- The API key in `~/.makefun/credentials` and the Solana keypair were never
  printed, copied, or written into any file in this entry (check confirms no
  committed provider key).
- The entry was built from the kit starter (its baseline routing/failover was
  replaced, per the starter's own TODOs); `lib/providers.ts` and `lib/wire.ts`
  keep the starter's parsing/translation and add ranking plus buffered streams.
- Local smoke ports were moved to 18273/18274: port 18080 on this VM is held by
  a sibling tiny-chess-01 env server (`node program/env/server.mjs`, pid 17428)
  — left untouched.

## Update 2026-11-16 ~15:34 WIB — GitHub owner
GitHub is connected. Repo owner is ZulkifliMohamad. README badges now point to ZulkifliMohamad/free-model-aggregator-02. .makefun/owner.json already contains wallet 4o4WqB3G7im2t3Y1FFzaeeKFJ9zVtWQHNy3HY6gQArwo. No repo created yet — parent will create it via ~/workspace/custom-connectors/custom.github/bin/github.py.
