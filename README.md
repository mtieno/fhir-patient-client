# fhir-patient-client

A small, dependency-free JavaScript client for downloading `Patient` and
`Observation` data from any [FHIR](https://www.hl7.org/fhir/) server.

## Why this shape?

- **Opinionated but not a walled garden.** `client.patients.list()` handles the
  common case. `client.search('Encounter', ...)` and `client.request(path)` are
  there when you need them.
- **Async iterators for paging.** FHIR search results are paginated with
  `Bundle.link[relation=next]`. `for await (const p of client.patients.stream())`
  handles that for you.
- **Extensible.** `patients` and `observations` are just `resourceHelper(...)`.
  Adding Encounters or Conditions is one line.
- **Resilient by default.** Network errors, HTTP 429, and HTTP 5xx are retried
  with exponential backoff. 4xx errors (bad requests, not-found, auth failures)
  are never retried — they're not going to succeed on attempt two.

## Install

No runtime dependencies. Node 18+ (uses built-in `fetch` and `node:test`).
`typescript` is an optional dev dependency, used only for `npm run typecheck`.

```bash
# from this directory
npm install                    # only needed for `npm run typecheck`
npm test                       # unit tests (fast, no network)
npm run test:integration       # hits hapi.fhir.org
npm run typecheck              # tsc --checkJs against src/, no build step
npm run example                # basic Patient example
npm run example:observations   # Patient + Observation example
```

## Usage

```js
import { createClient } from './src/index.js';

const client = createClient({
  baseUrl: 'https://hapi.fhir.org/baseR4',
  // token: 'your-bearer-token',   // optional
});

// One page
const bundle = await client.patients.list({ _count: 10 });
console.log(bundle.entry.map(e => e.resource.id));

// One patient
const alice = await client.patients.get('some-id');

// One patient, or null instead of a thrown error if it's a 404/410
const maybe = await client.patients.getOrNull('some-id');

// Everything in a patient's compartment: the Patient plus (server-dependent)
// their Observations, Conditions, Encounters, etc. — one call, one page.
const everything = await client.patients.everything('some-id');

// Same, but following pagination and yielding each resource as it arrives.
for await (const resource of client.patients.streamEverything('some-id')) {
  console.log(resource.resourceType, resource.id);
}

// Stream everything (follows paging automatically)
for await (const patient of client.patients.stream({ name: 'Smith' })) {
  console.log(patient.id);
}

// Observations for a patient
for await (const obs of client.observations.stream({
  patient: 'Patient/some-id',
  _count: 20,
})) {
  console.log(obs.code?.coding?.[0]?.display, obs.valueQuantity);
}

// Observations with an included Patient — includeAll yields the Patient too
for await (const r of client.observations.stream(
  { _include: 'Observation:patient' },
  { includeAll: true }
)) {
  console.log(r.resourceType, r.id);
}

// Search by identifier
await client.patients.byIdentifier('http://hospital.example/mrn', '12345');

// Escape hatches
const encounters = await client.search('Encounter', { patient: 'some-id' });
const metadata = await client.request('metadata');
```

## Errors

Non-2xx responses, and `OperationOutcome`s with error-severity issues, throw a
`FhirError`:

```js
import { FhirError } from './src/index.js';
try {
  await client.patients.get('missing');
} catch (err) {
  if (err instanceof FhirError) {
    console.error(err.status, err.outcome);
  }
}
```

Use `getOrNull` when a missing resource is an expected outcome rather than an
error you want to handle explicitly:

```js
const patient = await client.patients.getOrNull('maybe-missing');
if (!patient) { /* not found — carry on */ }
```

## Retries

Transient failures — network errors, HTTP 429, and HTTP 5xx — are retried
automatically with exponential backoff (2 retries, 300ms base delay, by
default). Everything else (404, 400, 401/403, malformed responses) fails
immediately, since retrying won't change the outcome.

```js
const client = createClient({
  baseUrl: 'https://hapi.fhir.org/baseR4',
  retries: 3,        // default: 2
  retryDelayMs: 500,  // default: 300 (doubles each attempt: 500, 1000, 2000...)
});

// Disable retries entirely:
const strict = createClient({ baseUrl: '...', retries: 0 });
```

## Streaming and `_include`

By default, `stream()` yields only entries matching the requested resource type.
If you use `_include` / `_revinclude`, the Bundle will contain other resource
types too — set `{ includeAll: true }` to yield those as well:

```js
// Only Observations
for await (const o of client.observations.stream({
  _include: 'Observation:patient',
})) { /* o.resourceType === 'Observation' */ }

// Observations *and* their Patients
for await (const r of client.observations.stream(
  { _include: 'Observation:patient' },
  { includeAll: true }
)) { /* r.resourceType is 'Observation' or 'Patient' */ }
```

## Limitations & future work

- **Auth**: only Bearer tokens are supported. OAuth2 / SMART-on-FHIR flows are
  out of scope. An `authProvider: () => Promise<headers>` hook would be the
  natural next step for token refresh.
- **Read-only**: no write operations.
- **Paging**: follows `link[relation=next]`. Servers that use non-standard
  paging (e.g. `_getpages` tokens) may not work.
- **Named helpers** cover `Patient` and `Observation`, plus the generic
  `operation()` escape hatch for any `$operation` (e.g. `Patient/$match`).
  `search()` covers everything else.
- **`$everything` pagination behaviour is server-dependent.** The FHIR spec
  doesn't mandate a specific paging strategy for `$everything`, so
  `streamEverything()` relies on the same `link[relation=next]` convention as
  `search()`. Servers that page `$everything` differently may need a
  server-specific workaround.
- **Search params are untyped strings.** This is deliberate (see NOTES.md,
  decision 1) — typing all ~145 FHIR R4 resources' search parameters would be
  a maintenance treadmill without saving the user from reading the spec. The
  tradeoff: a typo like `_conut` fails silently rather than being caught
  statically.

## AI disclosure

This code was developed with assistance from Claude (Anthropic) for
scaffolding, test structure, and boilerplate. Design decisions (API shape,
error handling, paging strategy, extensibility), test assertions, and final
review were performed by a human. No real patient data was sent to any AI
service during development — only public test servers were referenced.

After the initial commit, I used Claude for a peer review of the finished
client. It flagged three concrete gaps — no `Patient/$everything` /
compartment support, no retry/backoff for transient failures, and JSDoc
types that weren't actually being checked — and I used that review to guide
closing them; see NOTES.md for details.