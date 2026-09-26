import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, FhirError } from '../src/index.js';

/**
 * Build a fake fetch that records calls and replays scripted responses.
 * @param {Array<{status:number,statusText?:string,body:any}>} responses
 */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch call: ${url}`);
    const body =
      typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: next.statusText || '',
      text: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('builds the correct URL and headers', async () => {
  const fetch = fakeFetch([
    { status: 200, body: { resourceType: 'Bundle', entry: [] } },
  ]);
  const client = createClient({
    baseUrl: 'https://example.test/baseR4/',
    token: 'abc',
    fetch,
  });

  await client.patients.list({ _count: 2, name: 'Smith' });

  assert.equal(fetch.calls.length, 1);
  assert.equal(
    fetch.calls[0].url,
    'https://example.test/baseR4/Patient?_count=2&name=Smith'
  );
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer abc');
  assert.equal(fetch.calls[0].init.headers.Accept, 'application/fhir+json');
});

test('array params are repeated', async () => {
  const fetch = fakeFetch([{ status: 200, body: { resourceType: 'Bundle' } }]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });
  await client.patients.search({ identifier: ['a', 'b'] });
  assert.match(fetch.calls[0].url, /identifier=a&identifier=b/);
});

test('undefined params are skipped', async () => {
  const fetch = fakeFetch([{ status: 200, body: { resourceType: 'Bundle' } }]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });
  await client.patients.list({ name: undefined, _count: 1 });
  assert.equal(fetch.calls[0].url, 'https://x.test/Patient?_count=1');
});

test('get() URL-encodes the id', async () => {
  const fetch = fakeFetch([
    { status: 200, body: { resourceType: 'Patient', id: 'a b' } },
  ]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });
  await client.patients.get('a b');
  assert.equal(fetch.calls[0].url, 'https://x.test/Patient/a%20b');
});

test('non-2xx throws FhirError with status and outcome', async () => {
  const fetch = fakeFetch([
    {
      status: 404,
      statusText: 'Not Found',
      body: {
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'not-found' }],
      },
    },
  ]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });
  await assert.rejects(
    () => client.patients.get('missing'),
    (err) => {
      assert.ok(err instanceof FhirError);
      assert.equal(err.status, 404);
      assert.equal(err.outcome.resourceType, 'OperationOutcome');
      return true;
    }
  );
});

test('error-severity OperationOutcome on a 200 throws', async () => {
  const fetch = fakeFetch([
    {
      status: 200,
      body: {
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'invalid' }],
      },
    },
  ]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });
  await assert.rejects(() => client.search('Patient'), FhirError);
});

test('stream() follows next links across pages', async () => {
  const fetch = fakeFetch([
    {
      status: 200,
      body: {
        resourceType: 'Bundle',
        entry: [{ resource: { resourceType: 'Patient', id: '1' } }],
        link: [{ relation: 'next', url: 'https://x.test/Patient?_page=2' }],
      },
    },
    {
      status: 200,
      body: {
        resourceType: 'Bundle',
        entry: [{ resource: { resourceType: 'Patient', id: '2' } }],
      },
    },
  ]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });

  const ids = [];
  for await (const p of client.patients.stream({ _count: 1 })) ids.push(p.id);

  assert.deepEqual(ids, ['1', '2']);
  assert.equal(fetch.calls[1].url, 'https://x.test/Patient?_page=2');
});

test('stream() stops when no next link', async () => {
  const fetch = fakeFetch([
    {
      status: 200,
      body: {
        resourceType: 'Bundle',
        entry: [{ resource: { resourceType: 'Patient', id: 'x' } }],
      },
    },
  ]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });
  const ids = [];
  for await (const p of client.patients.stream()) ids.push(p.id);
  assert.deepEqual(ids, ['x']);
  assert.equal(fetch.calls.length, 1);
});

test('stream() filters to the requested resourceType by default', async () => {
  const fetch = fakeFetch([
    {
      status: 200,
      body: {
        resourceType: 'Bundle',
        entry: [
          { resource: { resourceType: 'Observation', id: 'o1' } },
          { resource: { resourceType: 'Patient', id: 'p1' } }, // from _include
        ],
      },
    },
  ]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });

  const ids = [];
  for await (const r of client.observations.stream({
    _include: 'Observation:patient',
  })) {
    ids.push(r.id);
  }
  assert.deepEqual(ids, ['o1']);
});

test('stream({ includeAll: true }) yields included resources too', async () => {
  const fetch = fakeFetch([
    {
      status: 200,
      body: {
        resourceType: 'Bundle',
        entry: [
          { resource: { resourceType: 'Observation', id: 'o1' } },
          { resource: { resourceType: 'Patient', id: 'p1' } },
        ],
      },
    },
  ]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });

  const ids = [];
  for await (const r of client.observations.stream({}, { includeAll: true })) {
    ids.push(r.id);
  }
  assert.deepEqual(ids, ['o1', 'p1']);
});

test('byIdentifier builds a FHIR token param', async () => {
  const fetch = fakeFetch([{ status: 200, body: { resourceType: 'Bundle' } }]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });

  await client.patients.byIdentifier('http://hospital.example/mrn', '12345');

  assert.equal(
    fetch.calls[0].url,
    'https://x.test/Patient?identifier=http%3A%2F%2Fhospital.example%2Fmrn%7C12345'
  );
});

test('byIdentifier with no system omits the pipe', async () => {
  const fetch = fakeFetch([{ status: 200, body: { resourceType: 'Bundle' } }]);
  const client = createClient({ baseUrl: 'https://x.test', fetch });

  await client.patients.byIdentifier(null, '12345');

  assert.equal(fetch.calls[0].url, 'https://x.test/Patient?identifier=12345');
});

test('createClient validates input', () => {
  assert.throws(() => createClient({}), /baseUrl/);
  assert.throws(() => createClient({ baseUrl: 'x', fetch: null }), /fetch/);
});