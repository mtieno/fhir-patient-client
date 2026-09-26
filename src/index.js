/**
 * fhir-patient-client
 *
 * A small, opinionated client for downloading FHIR data.
 *
 * Design goals:
 *  - Easy for intermediate JS devs: sensible defaults, clear errors, async iterators.
 *  - Not a walled garden: `request()` and `search()` give access to the raw FHIR API.
 *  - Extensible: `patients` and `observations` are thin helpers over `search()`.
 *
 * @see https://www.hl7.org/fhir/patient.html
 * @see https://www.hl7.org/fhir/observation.html
 */

/**
 * Error thrown when a FHIR server returns a non-2xx response or an
 * OperationOutcome with error-severity issues.
 */
export class FhirError extends Error {
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
 * Create a FHIR client.
 *
 * @param {object} options
 * @param {string} options.baseUrl - Base URL of the FHIR server, e.g. "https://hapi.fhir.org/baseR4".
 * @param {string} [options.token] - Optional Bearer token.
 * @param {object} [options.headers] - Extra headers to send with every request.
 * @param {typeof fetch} [options.fetch] - Custom fetch implementation (for testing / polyfills).
 * @returns {object} A FHIR client.
 */
export function createClient({ baseUrl, token: bearer, headers = {}, fetch = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error('createClient: baseUrl is required');
  if (typeof fetch !== 'function') throw new Error('createClient: no fetch available');

  const normalizedBase = baseUrl.replace(/\/+$/, '');

  function buildHeaders() {
    const h = { Accept: 'application/fhir+json', ...headers };
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    return h;
  }

  /**
   * Low-level request against the FHIR server. Returns parsed JSON.
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
   * Generic FHIR search. Returns a single Bundle page.
   *
   * @param {string} resourceType - e.g. "Patient".
   * @param {object} [params] - Query params. Values are stringified; arrays repeat the key.
   * @returns {Promise<object>} A FHIR Bundle.
   */
  async function search(resourceType, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach(item => qs.append(k, String(item)));
      else qs.append(k, String(v));
    }
    const query = qs.toString();
    return request(`${resourceType}${query ? `?${query}` : ''}`);
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
  async function* stream(resourceType, params = {}, opts = {}) {
    const { includeAll = false } = opts;
    let page = await search(resourceType, params);

    while (page) {
      for (const entry of page.entry || []) {
        const r = entry.resource;
        if (!r) continue;
        if (includeAll || r.resourceType === resourceType) yield r;
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
   * Named helper for a resource type. This is the extensibility point:
   * adding a new resource is a one-liner in the returned client below.
   *
   * @param {string} resourceType
   */
  function resourceHelper(resourceType) {
    return {
      list: (params) => search(resourceType, params),
      get: (id) => get(resourceType, id),
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
    };
  }

  return {
    /**
     * Patient helpers. See https://www.hl7.org/fhir/patient.html
     *
     *   client.patients.list({ _count: 10 })
     *   client.patients.get('123')
     *   for await (const p of client.patients.stream({ name: 'Smith' })) { ... }
     *   client.patients.byIdentifier('http://hospital.example/mrn', '12345')
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
    stream,
    request,
  };
}