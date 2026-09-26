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

## Install

No dependencies. Node 18+ (uses built-in `fetch` and `node:test`).

```bash
# from this directory
npm test                       # unit tests (fast, no network)
npm run test:integration       # hits hapi.fhir.org
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
  out of scope.
- **Read-only**: no write operations.
- **Paging**: follows `link[relation=next]`. Servers that use non-standard
  paging (e.g. `_getpages` tokens) may not work.
- **Named helpers** cover `Patient` and `Observation`. `search()` covers
  everything else.
- **No retries.** HAPI returns occasional 5xx errors. A retry-with-backoff
  wrapper is an obvious next step.

## AI disclosure

This code was developed with assistance from Claude (Anthropic) for
scaffolding, test structure, and boilerplate. Design decisions (API shape,
error handling, paging strategy, extensibility), test assertions, and final
review were performed by a human. No real patient data was sent to any AI
service during development — only public test servers were referenced.