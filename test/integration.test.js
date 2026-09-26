/**
 * Integration tests. These hit a real public FHIR server.
 * They are NOT run by `npm test` — run with `npm run test:integration`.
 * If hapi.fhir.org is down, swap in https://server.fire.ly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/index.js';

const BASE = 'https://hapi.fhir.org/baseR4';

test('can fetch a page of patients', { timeout: 20000 }, async () => {
  const client = createClient({ baseUrl: BASE });
  const bundle = await client.patients.list({ _count: 2 });
  assert.equal(bundle.resourceType, 'Bundle');
  assert.ok(Array.isArray(bundle.entry));
  assert.ok(bundle.entry.length > 0);
});

test('can stream a few patients', { timeout: 30000 }, async () => {
  const client = createClient({ baseUrl: BASE });
  const seen = [];
  for await (const p of client.patients.stream({ _count: 2 })) {
    seen.push(p.id);
    if (seen.length >= 3) break;
  }
  assert.ok(seen.length >= 1);
});

test('404 for a missing patient', { timeout: 20000 }, async () => {
  const client = createClient({ baseUrl: BASE });
  await assert.rejects(
    () => client.patients.get('this-id-should-not-exist-xyz-123'),
    (err) => err.status === 404 || err.status === 410
  );
});

test('can search Observations by patient', { timeout: 30000 }, async () => {
  const client = createClient({ baseUrl: BASE });

  // Find a patient that has at least one Observation.
  let patientId;
  outer: for await (const p of client.patients.stream({ _count: 20 })) {
    const obs = await client.observations.list({
      patient: `Patient/${p.id}`,
      _count: 1,
    });
    if (obs.entry?.length) {
      patientId = p.id;
      break outer;
    }
  }
  assert.ok(patientId, 'expected to find a patient with observations');

  const obsBundle = await client.observations.list({
    patient: `Patient/${patientId}`,
    _count: 5,
  });
  assert.equal(obsBundle.resourceType, 'Bundle');
  assert.ok(
    (obsBundle.entry ?? []).every(
      (e) => e.resource.resourceType === 'Observation'
    )
  );
});

test('_include does not break stream()', { timeout: 30000 }, async () => {
  const client = createClient({ baseUrl: BASE });
  let count = 0;
  for await (const r of client.observations.stream({
    _include: 'Observation:patient',
    _count: 5,
  })) {
    assert.equal(r.resourceType, 'Observation');
    if (++count >= 3) break;
  }
  assert.ok(count > 0, 'expected at least one Observation in the stream');
});