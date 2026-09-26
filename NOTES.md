# Notes

Submission notes for the FHIR Patient client coding exercise.

## What I built

A small, dependency-free JavaScript client for downloading `Patient` and
`Observation` data from any FHIR server. It is designed for intermediate
JavaScript developers who need to pull FHIR data without learning the full
FHIR search grammar first.

- **Stack**: Node 18+, ESM, built-in `fetch`, built-in `node:test`. Zero
  npm dependencies.
- **Interface**: `createClient({ baseUrl, token?, headers?, fetch? })`
  returns a client with `patients`, `observations`, `search`, `get`,
  `stream`, and `request`.
- **Paging**: `client.<resource>.stream(params)` is an async iterator that
  follows `Bundle.link[relation=next]` automatically, including HAPI's
  `_getpages` token-based paging.
- **Extensibility**: `patients` and `observations` are both produced by a
  single `resourceHelper(type)` factory. Adding a third resource is one line.

## What I ran

- `npm test` — unit tests, no network, fast, deterministic. All pass.
- `npm run test:integration` — hits `https://hapi.fhir.org/baseR4`.
  All 5 pass.
- `npm run example` — fetches and prints Patients.
- `npm run example:observations` — finds a Patient with Observations and
  streams them.

## Design decisions I'd defend

1. **Free-form `SearchParams` rather than typed per-resource params.**
   FHIR R4 has 145 resource types and each has its own search parameters.
   Typing them all is a maintenance treadmill and doesn't help the user
   anyway — they still need to read the spec. Accepting
   `Record<string, string | number | string[]>` lets the whole spec flow
   through without the client pretending to understand it.

2. **Async iterators for paging, promises for single pages.**
   Paging is the #1 thing that trips up FHIR newcomers — it's easy to
   forget `Bundle.link[next]` and silently return only the first page.
   `for await (const p of client.patients.stream())` makes the common case
   correct by default.

3. **`stream()` filters to the requested `resourceType` by default.**
   If you pass `_include=Observation:patient`, the Bundle contains Patients
   too. Yielding them silently surprises users who asked for Observations.
   `{ includeAll: true }` opts out.

4. **`byIdentifier` as sugar; `token()` as the primitive.**
   Identifier search is common enough to warrant a helper. But I did *not*
   add `byCode` for Observations, because that's the top of a slippery
   slope — the primitive is the answer for everything else.

5. **Zero dependencies.** Node 18 has `fetch` and `node:test` built in.
   Adding a runner or an HTTP library would gain little and cost a supply
   chain.

## Bugs found and fixed during testing

**`_getpages` paging (HAPI).**

HAPI returns `next` links using the `_getpages` token profile. These point
at the *server root* (`/baseR4?_getpages=...`), not at the resource path
(`/baseR4/Patient?...`). My original `stream()` stripped the base and
re-prefixed it in `request()`, producing:

    https://hapi.fhir.org/baseR4/https://hapi.fhir.org/baseR4?_getpages=...

which HAPI rejects with 400 "Ambiguous URI empty segment".

Fixed with two complementary changes:

- `stream()` resolves `next` via `new URL(next, normalizedBase + '/')`.
  This correctly handles absolute URLs, root-relative URLs, and relative
  URLs.
- `request()` passes absolute URLs through untouched instead of always
  prefixing the base. This makes the low-level primitive tolerant of what
  `stream()` now hands it.

The lesson: when you change what a caller passes to a function, you have
to update the function's contract too. Both changes were needed.

Regression tests added for the HAPI `_getpages` form and for relative
`next` links.

## What I'd do with another day

1. ~~**Retry-with-backoff** around `request()`.~~ Done — see "Peer review
   round" below.

2. ~~**`tsc --checkJs` in CI.**~~ Done — see "Peer review round" below.

3. **`authProvider: () => Promise<headers>` hook.** Bearer tokens cover
   most real servers; OAuth2 / SMART-on-FHIR would need a callback so the
   client can refresh tokens without the user managing them. Still open.

4. **Tighten the integration test that scans patients for observations.**
   It walks up to 20 patients sequentially. On a slow day that's 20 round
   trips. Parallelize the first few, or reduce the window. Still open.

5. ~~**`getOrNull(id)`.**~~ Done — see "Peer review round" below.

## Peer review round

After the initial commit, I gave the finished client (source, tests, README,
these notes) to Claude for a peer review. It rated the submission and called
out four things explicitly; I used that to prioritize what to close before
calling this done:

1. **No `Patient/$everything` / compartment support**, despite the
   assignment being framed around "downloading patient data" — in real FHIR
   usage that often means the whole compartment (Observations, Conditions,
   Encounters, etc.), not just the `Patient` resource in isolation.
2. **No retry/backoff**, flagged as more load-bearing than some of the other
   "future work" items given the client's own notes about HAPI's flakiness.
3. **`tsc --checkJs` was promised but not wired up** — the JSDoc types were
   asserted, not enforced.
4. Untyped, free-form search params — flagged as a defensible, documented
   tradeoff rather than a bug, so left as-is (see decision 1 above).

What changed as a result:

- **`$everything` support.** Added a generic `operation(resourceType, id,
  name, params)` primitive for any FHIR `$operation`, plus
  `patients.everything(id, params)` (one Bundle page) and
  `patients.streamEverything(id, params)` (follows pagination, yields every
  resource in the compartment regardless of type — the whole point of
  `$everything` is that it returns mixed resource types, so unlike
  `stream()` there's no `resourceType` to filter to by default).
  To avoid duplicating the pagination-following logic between `stream()` and
  `streamEverything()`, I pulled it out into a shared `paginate()` generator
  that both now call.

- **Retry-with-backoff.** `request()` now retries network errors, HTTP 429,
  and HTTP 5xx up to `retries` times (default 2) with exponential backoff
  (`retryDelayMs * 2^attempt`, default base 300ms). 4xx errors other than
  429 are never retried. `retries` and `retryDelayMs` are `createClient`
  options; `sleep` is also overridable so tests don't actually wait. Eight
  new unit tests cover this: retry-then-succeed for both 503 and 429,
  no-retry on 404, exhausting retries and throwing the last error,
  `retries: 0` disabling retries, and the backoff delay actually doubling.

- **`getOrNull(id)`.** Returns `null` on 404/410 instead of throwing;
  rethrows everything else. Exposed both as `client.getOrNull(type, id)` and
  `client.patients.getOrNull(id)` / `client.observations.getOrNull(id)`.

- **`tsc --checkJs` actually wired up and actually passing.** This is worth
  being honest about: turning it on the first time surfaced real errors, not
  hypothetical ones — mostly because `createClient`'s options weren't backed
  by a proper JSDoc `@typedef`, so TypeScript inferred an overly strict
  shape from the destructuring pattern and defaults. Fixed by:
  - Adding a `ClientOptions` typedef with `baseUrl` marked optional at the
    type level (it's still required at runtime, validated with a clear
    thrown error) so `createClient()` and `createClient({})` — used
    deliberately in tests to exercise that validation — still type-check.
  - Typing `FhirError`'s constructor details param explicitly.
  - Typing `buildHeaders()`'s return value so conditionally setting
    `Authorization` type-checks.
  - Scoping `tsconfig.json`'s `include` to `src/**/*.js` only. The test
    files use `node:test` / `node:assert` globals that need `@types/node`
    to type-check cleanly, and pulling that in just to check test scaffolding
    (not shipped code) felt like the wrong trade for this exercise. If this
    were a long-lived project I'd add `@types/node` as a dev dependency and
    check the tests too.
  - `noImplicitAny: false` — full `strict: true` demanded either typing the
    genuinely-dynamic FHIR JSON payloads (which decision 1 explicitly chose
    not to do) or littering the file with `any`. I kept `strictNullChecks`
    and `strictFunctionTypes` on, since those catch real bugs (e.g. calling
    a possibly-undefined function), and left `noImplicitAny` off since it
    was mostly flagging FHIR payload shapes by design.

  `npm run typecheck` now runs `tsc --noEmit -p .` and passes cleanly
  against `src/`. `typescript` is a dev dependency (only needed to run that
  script), not a runtime one.

All 27 unit tests pass after these changes (up from 13); the four
integration tests for the new endpoints weren't added since they'd need a
public server known to have `$everything`-capable patients, but
`everything()`/`streamEverything()` follow the exact same `request()` /
`paginate()` code paths already exercised against `hapi.fhir.org` by the
existing integration suite.

## Known limitations

- **Auth**: Bearer tokens only. No OAuth2 / SMART-on-FHIR flows.
- **Read-only**: no write operations.
- **Paging**: handles `_getpages`, absolute, root-relative, and relative
  `next` links, for both `search()` and `$everything`. Servers that require
  special headers on `next` fetches (some SMART servers) are not supported.
- **Named helpers** cover Patient and Observation, plus a generic
  `operation()` for any `$operation`. `search()` covers the rest of FHIR.
- **Retry is bounded but not circuit-broken.** A server that's down for
  minutes will still be retried on every subsequent call from scratch —
  there's no shared backoff state across calls.

## AI disclosure

Developed with assistance from Claude (Anthropic) for scaffolding, test
structure, and boilerplate. Specifically:

- **AI-assisted**: initial `package.json` and README skeletons; first
  draft of JSDoc; the `fakeFetch` test helper; this list's structure; the
  peer review described above, and the follow-up implementation of the
  gaps it identified.
- **Human-directed**: the API shape, the `resourceHelper` factory pattern,
  the `includeAll` filter decision, all error-handling semantics, the
  `_getpages` fix (found via real integration tests, not speculation), and
  the decision of which review feedback to act on vs. leave as a documented
  tradeoff (e.g. keeping search params untyped).
- **Verification**: the AI did not execute the code during the initial
  build. The human ran every test, discovered the `_getpages` bug, and
  confirmed the fix. For the peer-review round, the new retry/backoff,
  `getOrNull`, and `$everything` code was run against the unit test suite
  (all 27 passing) and `tsc --checkJs` was actually executed against
  `src/`, not just claimed to pass.

No real patient data was sent to any AI service. Only public test servers
(`hapi.fhir.org`) were queried during development.