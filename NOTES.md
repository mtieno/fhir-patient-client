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

1. **Retry-with-backoff** around `request()`. HAPI occasionally returns
   5xx; a bounded retry would smooth over public-server flakiness. One unit
   test would cover it: 503 retried, 404 not.

2. **`tsc --checkJs` in CI.** The JSDoc is already there. Running the
   TypeScript checker with `noEmit: true` would catch drift between docs
   and code for free. No build step needed.

3. **`authProvider: () => Promise<headers>` hook.** Bearer tokens cover
   most real servers; OAuth2 / SMART-on-FHIR would need a callback so the
   client can refresh tokens without the user managing them.

4. **Tighten the integration test that scans patients for observations.**
   It walks up to 20 patients sequentially. On a slow day that's 20 round
   trips. Parallelize the first few, or reduce the window.

5. **`getOrNull(id)`.** Returns `null` on 404 instead of throwing.
   Small, common need.

## Known limitations

- **Auth**: Bearer tokens only. No OAuth2 / SMART-on-FHIR flows.
- **Read-only**: no write operations.
- **Paging**: handles `_getpages`, absolute, root-relative, and relative
  `next` links. Servers that require special headers on `next` fetches
  (some SMART servers) are not supported.
- **Named helpers** cover Patient and Observation. `search()` covers the
  rest of FHIR.

## AI disclosure

Developed with assistance from Claude (Anthropic) for scaffolding, test
structure, and boilerplate. Specifically:

- **AI-assisted**: initial `package.json` and README skeletons; first
  draft of JSDoc; the `fakeFetch` test helper; this list's structure.
- **Human-directed**: the API shape, the `resourceHelper` factory pattern,
  the `includeAll` filter decision, all error-handling semantics, and the
  `_getpages` fix (found via real integration tests, not speculation).
- **Verification**: the AI did not execute the code. The human ran every
  test, discovered the `_getpages` bug, and confirmed the fix. This
  distinction matters — the code is only trustworthy because it was
  actually run against a live server.

No real patient data was sent to any AI service. Only public test servers
(`hapi.fhir.org`) were queried during development.