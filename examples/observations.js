import { createClient } from '../src/index.js';

const client = createClient({ baseUrl: 'https://hapi.fhir.org/baseR4' });

// Find any patient who has observations, then stream a few of those observations.
console.log('Looking for a patient with observations...\n');

let patientId;
outer: for await (const p of client.patients.stream({ _count: 20 })) {
  const { entry } = await client.observations.list({
    patient: `Patient/${p.id}`,
    _count: 1,
  });
  if (entry?.length) {
    patientId = p.id;
    break outer;
  }
}

if (!patientId) {
  console.log('No patients with observations found on this server.');
  process.exit(0);
}

console.log(`Patient ${patientId} has observations. Streaming up to 5:\n`);

let n = 0;
for await (const obs of client.observations.stream({
  patient: `Patient/${patientId}`,
  _count: 5,
})) {
  const code = obs.code?.coding?.[0];
  const value = obs.valueQuantity
    ? `${obs.valueQuantity.value} ${obs.valueQuantity.unit ?? ''}`.trim()
    : obs.valueString ?? '(no value)';
  console.log(`  ${obs.id}  ${code?.display ?? code?.code ?? '?'}  →  ${value}`);
  if (++n >= 5) break;
}