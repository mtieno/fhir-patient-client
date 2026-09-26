import { createClient } from '../src/index.js';

const client = createClient({ baseUrl: 'https://hapi.fhir.org/baseR4' });

console.log('Fetching 3 patients...\n');

const bundle = await client.patients.list({ _count: 3 });
for (const entry of bundle.entry ?? []) {
  const p = entry.resource;
  const name = p.name?.[0];
  const display = name
    ? [name.given?.join(' '), name.family].filter(Boolean).join(' ')
    : '(no name)';
  console.log(`  ${p.id}  ${display}  ${p.gender ?? ''}`);
}

console.log('\nStreaming patients with a name filter...\n');

let count = 0;
for await (const p of client.patients.stream({ name: 'Smith', _count: 5 })) {
  console.log(`  ${p.id}`);
  if (++count >= 5) break;
}