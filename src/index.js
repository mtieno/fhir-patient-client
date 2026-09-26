/**
 * fhir-patient-client
 *
 * A small, opinionated client for downloading FHIR data.
 *
 * Design goals:
 *  - Easy for intermediate JS devs: sensible defaults, clear errors, async iterators.
 *  - Not a walled garden: `request()` and `search()` give access to the raw FHIR API.
 *  - Extensible: `patients` and `observations` are thin helpers over `search()`.
 *  - Resilient: bounded retry-with-backoff on transient (network / 429 / 5xx) failures.
 *
 * @see https://www.hl7.org/fhir/patient.html
 * @see https://www.hl7.org/fhir/observation.html
 * @see https://www.hl7.org/fhir/operation-patient-everything.html
 */

/**
 * Error thrown when a FHIR server returns a non-2xx response or an
 * OperationOutcome with error-severity issues.
 */
export class FhirError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, outcome?: any, url?: string}} [details]
   */
  constructor(message, { status, outcome, url } = {}) {
    super(message);
    this.name = 'FhirError';
    this.status = status;
    this.outcome = outcome;
    this.url = url;
  }
}

/**
 * Build a FHIR token search param: "system|value".
 * If no system is provided, returns just the value.
 *
 * @param {string|null} system
 * @param {string} value
 * @returns {string}
 */
function token(system, value) {
  if (!system) return String(value);
  return `${system}|${value}`;
}

/**
 * Serialize a params object into a FHIR query string (including the
 * leading "?"), or "" if there are no params. Arrays repeat the key.
 * `undefined`/`null` values are skipped.
 *
 * @param {object} [params]
 * @returns {string}
 */
function buildQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach(item => qs.append(k, String(item)));
    else qs.append(k, String(v));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

/**
 * Default sleep implementation, used between retry attempts.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Options accepted by {@link createClient}. `baseUrl` is required at
 * runtime (validated with a clear error if missing) but is typed as
 * optional here so that `createClient()` and `createClient({})` — used
 * deliberately in tests to exercise that validation — still type-check.
 *
 * @typedef {object} ClientOptions
 * @property {string} [baseUrl] - Base URL of the FHIR server, e.g. "https://hapi.fhir.org/baseR4".
 * @property {string} [token] - Optional Bearer token.
 * @property {Record<string, string>} [headers] - Extra headers to send with every request.
 * @property {typeof fetch} [fetch] - Custom fetch implementation (for testing / polyfills).
 * @property {number} [retries] - Number of retry attempts for transient failures
 *   (network errors, HTTP 429, HTTP 5xx). Default 2. Set to 0 to disable. Non-transient
 *   errors (4xx other than 429) are never retried.
 * @property {number} [retryDelayMs] - Base delay in ms before the first retry. Default 300.
 *   Subsequent retries back off exponentially (delay * 2^attempt).
 * @property {(ms: number) => Promise<void>} [sleep] - Sleep implementation used
 *   between retries. Overridable for tests so they don't actually wait.
 */

/**
 * Create a FHIR client.
 *
 * @param {ClientOptions} [options]
 * @returns {object} A FHIR client.
 */
export function createClient({
  baseUrl,
  token: bearer,
  headers = {},
  fetch = globalThis.fetch,
  retries = 2,
  retryDelayMs = 300,
  sleep = defaultSleep,
} = {}) {
  if (!baseUrl) throw new Error('createClient: baseUrl is required');
  if (typeof fetch !== 'function') throw new Error('createClient: no fetch available');

  const normalizedBase = baseUrl.replace(/\/+$/, '');

  /** @returns {Record<string, string>} */
  function buildHeaders() {
    /** @type {Record<string, string>} */
    const h = { Accept: 'application/fhir+json', ...headers };
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return h;
  }

  /**
   * A single fetch + parse + FHIR-aware error check, no retry logic.
   * @param {string} url
   * @param {object} init
   * @returns {Promise<any>}
   */
  async function doFetch(url, init) {
    const res = await fetch(url, {
      ...init,
      headers: { ...buildHeaders(), ...(init.headers || {}) },
    });

    let body;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }

    if (!res.ok) {
      throw new FhirError(
        `FHIR request failed: ${res.status} ${res.statusText}`,
        { status: res.status, outcome: body, url }
      );
    }

    if (
      body?.resourceType === 'OperationOutcome' &&
      body.issue?.some(i => i.severity === 'error' || i.severity === 'fatal')
    ) {
      throw new FhirError('FHIR OperationOutcome reported an error', {
        status: res.status,
        outcome: body,
        url,
      });
    }

    return body;
  }

  /**
   * True if an error represents a transient failure worth retrying:
   * a network-level error (no HTTP status at all), HTTP 429, or any 5xx.
   * @param {any} err
   */
  function isRetryable(err) {
    if (!(err instanceof FhirError)) return true; // network/DNS/etc. error
    if (err.status === undefined) return true;
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }

  /**
   * Low-level request against the FHIR server. Returns parsed JSON.
   * Transient failures (network errors, 429, 5xx) are retried up to
   * `retries` times with exponential backoff; other errors (4xx, parse
   * errors) are thrown immediately.
   *
   * @param {string} path - e.g. "Patient/123" or "Patient?name=Smith".
   * @param {object} [init] - fetch init overrides.
   * @returns {Promise<any>}
   */
  async function request(path, init = {}) {
    // If `path` is already an absolute URL (e.g. a HAPI _getpages link),
    // use it as-is. Otherwise prefix it with our base.
    const url = /^https?:\/\//i.test(path)
      ? path
      : `${normalizedBase}/${path.replace(/^\/+/, '')}`;

    let attempt = 0;
    for (;;) {
      try {
        return await doFetch(url, init);
      } catch (err) {
        if (attempt >= retries || !isRetryable(err)) throw err;
        const delay = retryDelayMs * 2 ** attempt;
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  /**
   * Generic FHIR search. Returns a single Bundle page.
   *
   * @param {string} resourceType - e.g. "Patient".
   * @param {object} [params] - Query params. Values are stringified; arrays repeat the key.
   * @returns {Promise<object>} A FHIR Bundle.
   */
  async function search(resourceType, params = {}) {
    return request(`${resourceType}${buildQuery(params)}`);
  }

  /**
   * Fetch a single resource by id.
   *
   * @param {string} resourceType
   * @param {string} id
   * @returns {Promise<object>}
   */
  async function get(resourceType, id) {
    return request(`${resourceType}/${encodeURIComponent(id)}`);
  }

  /**
   * Fetch a single resource by id, or `null` if the server returns 404/410
   * instead of throwing. Other errors (5xx after retries, network failures,
   * auth failures) still throw.
   *
   * @param {string} resourceType
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async function getOrNull(resourceType, id) {
    try {
      return await get(resourceType, id);
    } catch (err) {
      if (err instanceof FhirError && (err.status === 404 || err.status === 410)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Call a FHIR "type" or "instance" level operation, e.g.
   * `Patient/123/$everything`. Returns a single Bundle page.
   *
   * @param {string} resourceType - e.g. "Patient".
   * @param {string|null} id - Instance id, or null for a type-level operation.
   * @param {string} name - Operation name without the "$", e.g. "everything".
   * @param {object} [params]
   * @returns {Promise<object>}
   */
  async function operation(resourceType, id, name, params = {}) {
    const path = id
      ? `${resourceType}/${encodeURIComponent(id)}/$${name}`
      : `${resourceType}/$${name}`;
    return request(`${path}${buildQuery(params)}`);
  }

  /**
   * Yield every resource across every page of an already-fetched Bundle,
   * following `Bundle.link[relation=next]` until exhausted. Shared by
   * `stream()` and `streamEverything()`.
   *
   * @param {Promise<object>} firstPage - Promise resolving to the first Bundle.
   * @param {object} [opts]
   * @param {string|null} [opts.filterType] - If set, only yield entries whose
   *   resourceType matches. If null, yield every entry as-is.
   * @param {boolean} [opts.includeAll=false] - When `filterType` is set, also
   *   yield entries of other resource types (e.g. `_include`d resources).
   * @returns {AsyncGenerator<object>}
   */
  async function* paginate(firstPage, opts = {}) {
    const { filterType = null, includeAll = false } = opts;
    let page = await firstPage;

    while (page) {
      for (const entry of page.entry || []) {
        const r = entry.resource;
        if (!r) continue;
        if (!filterType || includeAll || r.resourceType === filterType) yield r;
      }

      const next = page.link?.find(l => l.relation === 'next')?.url;
      if (!next) return;

      // Resolve `next` against our base. This handles all forms:
      //   - absolute URL (HAPI _getpages): used verbatim
      //   - root-relative "/Patient?...": resolved against base
      //   - relative "Patient?...": resolved against base
      const resolved = new URL(next, normalizedBase + '/').toString();
      page = await request(resolved);
    }
  }

  /**
   * Yield every resource across every page of a search.
   * Follows Bundle.link[relation=next] until exhausted.
   *
   * @param {string} resourceType
   * @param {object} [params]
   * @param {object} [opts]
   * @param {boolean} [opts.includeAll=false] - If false (default), only yield
   *   entries whose resourceType matches `resourceType`. Set true to yield
   *   included resources (e.g. `_include`d Patients) as well.
   * @returns {AsyncGenerator<object>}
   */
  function stream(resourceType, params = {}, opts = {}) {
    const { includeAll = false } = opts;
    return paginate(search(resourceType, params), { filterType: resourceType, includeAll });
  }

  /**
   * Named helper for a resource type. This is the extensibility point:
   * adding a new resource is a one-liner in the returned client below.
   *
   * @param {string} resourceType
   */
  function resourceHelper(resourceType) {
    return {
      list: (params) => search(resourceType, params),
      get: (id) => get(resourceType, id),
      /**
       * Like `get`, but returns `null` on 404/410 instead of throwing.
       * @param {string} id
       */
      getOrNull: (id) => getOrNull(resourceType, id),
      stream: (params, opts) => stream(resourceType, params, opts),
      search: (params) => search(resourceType, params),
      /**
       * Convenience: search by identifier system + value.
       *
       * @param {string|null} system - e.g. "http://hospital.example/mrn".
       * @param {string} value
       */
      byIdentifier: (system, value) =>
        search(resourceType, { identifier: token(system, value) }),
      /**
       * Call the `$everything` operation for a single instance, e.g.
       * `Patient/123/$everything`. Returns one Bundle page containing the
       * resource itself plus everything in its compartment (Observations,
       * Conditions, Encounters, etc. — server-dependent). Use
       * `streamEverything` to follow pagination automatically.
       *
       * @param {string} id
       * @param {object} [params] - e.g. `{ _since: '2024-01-01', _count: 50 }`.
       * @returns {Promise<object>} A FHIR Bundle.
       * @see https://www.hl7.org/fhir/operation-patient-everything.html
       */
      everything: (id, params) => operation(resourceType, id, 'everything', params),
      /**
       * Like `everything`, but as an async iterator that follows pagination
       * and yields every resource in the compartment, regardless of type
       * (the whole point of `$everything` is that it returns mixed types).
       *
       * @param {string} id
       * @param {object} [params]
       * @returns {AsyncGenerator<object>}
       */
      streamEverything: (id, params) =>
        paginate(operation(resourceType, id, 'everything', params)),
    };
  }

  return {
    /**
     * Patient helpers. See https://www.hl7.org/fhir/patient.html
     *
     *   client.patients.list({ _count: 10 })
     *   client.patients.get('123')
     *   client.patients.getOrNull('123')            // null instead of throwing on 404
     *   for await (const p of client.patients.stream({ name: 'Smith' })) { ... }
     *   client.patients.byIdentifier('http://hospital.example/mrn', '12345')
     *   client.patients.everything('123')            // Patient/123/$everything, one page
     *   for await (const r of client.patients.streamEverything('123')) { ... }
     */
    patients: resourceHelper('Patient'),

    /**
     * Observation helpers. See https://www.hl7.org/fhir/observation.html
     *
     *   client.observations.list({ patient: 'Patient/123', _count: 10 })
     *   for await (const o of client.observations.stream(
     *     { _include: 'Observation:patient' }, { includeAll: true }
     *   )) { ... }
     */
    observations: resourceHelper('Observation'),

    // Extensibility: add more resources here as needed.
    // e.g.:
    //   encounters:  resourceHelper('Encounter'),
    //   conditions:  resourceHelper('Condition'),

    search,
    get,
    getOrNull,
    operation,
    stream,
    request,
  };
}
