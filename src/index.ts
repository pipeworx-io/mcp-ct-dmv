interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Connecticut DMV MCP — electric-vehicle registrations at vehicle level, aggregated on
 * demand by town, make, model, model year or body type. Keyless.
 *
 * One pack per state agency: Connecticut publishes one row per registered electric vehicle
 * (60,489 of them, with plate type, town, weight, colour and expiry), a grain that has
 * nothing in common with California's ZIP-level counts or Texas's single statewide annual
 * total. Connecticut therefore gets its own tool whose arguments are all real, instead of a
 * union schema where most arguments are ignored.
 *
 * Source (verified live 2026-07-29):
 *   data.ct.gov Socrata y7ky-5wcz — CT DMV "Electric Vehicle Registration Data", 60,489
 *   vehicle-level rows, last refreshed 2025-02-28.
 *
 * Because the file is a snapshot taken in February 2025, `as_of` and a `note` carry that
 * vintage on every response; a Tesla count read as "today" would be wrong by a year.
 *
 * Rejected while building: data.ct.gov apne-w8c6, published as "Licensed Automobile Dealers
 * And Repairers", holds 138 manufacturer licences held mostly by out-of-state RV and trailer
 * makers (23 in Indiana, 18 in California, 2 in Connecticut). It cannot answer "find a
 * licensed dealer or repairer near me", so no tool wraps it.
 *
 * Every tool resolves to a shaped object and never throws; a query this file cannot answer
 * comes back as { found: false, reason, hint } naming a dimension that does work.
 */


const UA = 'pipeworx-mcp-ct-dmv/1.0 (+https://pipeworx.io)';
const DOMAIN = 'data.ct.gov';
const RESOURCE = 'y7ky-5wcz';
const SOURCE = `data.ct.gov — CT DMV Electric Vehicle Registration Data (${RESOURCE})`;
const SNAPSHOT_NOTE =
  'Connecticut last refreshed this file on 2025-02-28, so it is a snapshot of the electric ' +
  'vehicles registered as of February 2025 rather than a live count.';

/**
 * `fuelcode` holds Connecticut's internal codes (E00, H04, H06, G04) and the dataset ships no
 * codebook, so the values are passed through unmapped rather than guessed at. `vehicle_type`
 * and `category` are the readable dimensions.
 */
const FUEL_CODE_NOTE =
  'The fuel values are Connecticut DMV internal codes (E00, H04, H06, G04) and the dataset ' +
  'publishes no key for them, so they are returned as-is; group_by="vehicle_type" or ' +
  'group_by="category" returns readable labels.';

/** group_by argument → the column Connecticut actually publishes. */
const GROUP_COLUMNS: Record<string, string> = {
  city: 'primarycustomercity',
  make: 'vehiclemake',
  model: 'vehiclemodel',
  model_year: 'vehicleyear',
  vehicle_type: 'vehicletype',
  body: 'vehiclebody',
  fuel: 'fuelcode',
  color: 'primarycolor',
  plate_type: 'platetype',
  usage: 'registrationusage',
  category: 'vehicle_category',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'ct_dmv_ev_registrations',
    description:
      'Count electric vehicles registered in Connecticut from the Connecticut DMV\'s vehicle-level registration file, broken down by town, make, model, model year, body style, fuel code, colour, plate type or registration usage. Answers "how many electric vehicles are registered in Connecticut", "how many Teslas are registered in Connecticut", "which Connecticut town has the most EVs", "most popular EV models in Connecticut", and "how many EVs registered in Stamford". Built from 60,489 individual registration records, a snapshot covering electric vehicles registered as of February 2025, so every response reports that vintage. For the whole Connecticut vehicle fleet including petrol and diesel, ca_dmv_vehicle_registrations covers California\'s full fuel mix by ZIP.',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: {
          type: 'string',
          description: 'Breakdown dimension: city (default), make, model, model_year, vehicle_type, body, fuel, color, plate_type, usage, category.',
        },
        city: { type: 'string', description: 'Connecticut town of the registered owner, e.g. "Stamford", "West Hartford".' },
        make: { type: 'string', description: 'Vehicle make, matched as a substring, e.g. "Tesla", "Toyota", "Jeep".' },
        model: { type: 'string', description: 'Vehicle model, matched as a substring, e.g. "Model 3", "Wrangler".' },
        model_year: { type: 'string', description: 'Four-digit model year, e.g. "2024".' },
        vehicle_type: { type: 'string', description: 'Vehicle type as Connecticut records it, matched as a substring, e.g. "Passenger", "Truck".' },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200).' },
      },
    },
  },
];

async function evRegistrations(args: Record<string, unknown>): Promise<unknown> {
  const groupKey = (govString(args, 'group_by') ?? 'city').toLowerCase();
  const groupCol = GROUP_COLUMNS[groupKey];
  if (!groupCol) {
    return govNotFound(
      'unsupported_group_by',
      `Connecticut's EV file supports group_by of ${Object.keys(GROUP_COLUMNS).join(', ')}.`,
      { supported_group_by: Object.keys(GROUP_COLUMNS) },
    );
  }

  const where: string[] = [];
  const city = govString(args, 'city');
  if (city) where.push(`upper(primarycustomercity) like '%${soqlEscape(city.toUpperCase())}%'`);
  const make = govString(args, 'make');
  if (make) where.push(`upper(vehiclemake) like '%${soqlEscape(make.toUpperCase())}%'`);
  const model = govString(args, 'model');
  if (model) where.push(`upper(vehiclemodel) like '%${soqlEscape(model.toUpperCase())}%'`);
  const modelYear = govString(args, 'model_year');
  if (modelYear) where.push(`vehicleyear='${soqlEscape(modelYear)}'`);
  const vehicleType = govString(args, 'vehicle_type');
  if (vehicleType) where.push(`upper(vehicletype) like '%${soqlEscape(vehicleType.toUpperCase())}%'`);
  const filters = { city, make, model, model_year: modelYear, vehicle_type: vehicleType };

  const limit = govLimit(args.limit, 25, 200);
  const rows = await soqlRows<{ grouped?: string; vehicles?: string }>(
    DOMAIN,
    RESOURCE,
    {
      select: `${groupCol} as grouped, count(1) as vehicles`,
      where: where.length ? where.join(' AND ') : undefined,
      group: groupCol,
      order: groupKey === 'model_year' ? 'vehicleyear DESC' : 'count(1) DESC',
      limit,
    },
    { userAgent: UA },
  );
  if (!rows.length) {
    return govNotFound(
      'no_matching_records',
      `No Connecticut EV registrations matched those filters. Towns are plain names ("Stamford", "West Hartford") and makes are mixed case ("Tesla", "KIA"); drop the narrowest filter, or call with no arguments for the towns with the most EVs.`,
      { filters_applied: filters },
    );
  }

  const shaped = rows.map((r) => ({
    [groupKey]: r.grouped ?? 'unspecified',
    vehicles: govNumber(r.vehicles),
  }));
  const returned = shaped.reduce((a, r) => a + (r.vehicles ?? 0), 0);
  const truncated = shaped.length >= limit;

  return {
    state: 'CT',
    grain: `count of electric-vehicle registration records by ${groupKey}${city ? ` in ${city}` : ''}`,
    as_of: await soqlUpdatedAt(DOMAIN, RESOURCE, { userAgent: UA }),
    source: SOURCE,
    covers: 'electric vehicles registered in Connecticut as of the February 2025 snapshot',
    ...(where.length ? { filters_applied: filters } : {}),
    // Only a call that returns every group is a true EV total, and `limit` routinely cuts one
    // off (there are ~170 Connecticut towns), so the sum is labelled as the returned rows only.
    sum_of_returned_rows: returned,
    truncated,
    rows: shaped,
    note: groupKey === 'fuel' ? `${SNAPSHOT_NOTE} ${FUEL_CODE_NOTE}` : SNAPSHOT_NOTE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'ct_dmv_ev_registrations': return await evRegistrations(args);
      default:
        return govNotFound('unknown_tool', `ct-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `ct-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'data.ct.gov timed out. Retry once, and lower `limit` or add a filter to reduce the work upstream.'
        : 'data.ct.gov refused the request or changed shape. Retry once; if it persists the dataset may have been republished under a new Socrata id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
