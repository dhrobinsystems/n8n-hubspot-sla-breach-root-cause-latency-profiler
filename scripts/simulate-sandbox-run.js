#!/usr/bin/env node
/*
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-sla-breach-root-cause-latency-profiler.
 *
 * Zero dependencies and zero network modules: only fs, path and vm are
 * required. Code-node JavaScript is taken verbatim from workflow.json and run
 * in isolated VM contexts by a small engine that follows workflow.json's
 * connections, evaluates IF / HTTP {{ expressions }}, emulates HTTP pagination
 * (body and query-string cursors) and n8n workflow static data. HTTP nodes are
 * routed to in-memory HubSpot / Slack / Teams mocks; the HubSpot mock really
 * evaluates the search filters, so a wrong search body fails the tests.
 *
 * Verifies: structure and static safety, safe defaults, config validation,
 * webhook auth and destination allowlisting, fixture parity and PII-free data,
 * timestamp parsing, wall and business-hours clocks, every lead scenario
 * (fast routing, ingest / enrichment / assignment delays, unassigned and
 * missed-dial open breaches, skipped stages, clock skew, anomalies), root-cause
 * attribution, percentiles against an independent reference, bottleneck
 * detection, guards, Slack / Teams payloads and escaping, live search
 * pagination and fail-closed limits, posting, duplicate-post protection,
 * trend snapshots and the contact SLA-field write.
 *
 * Usage:  node scripts/simulate-sandbox-run.js [--quiet]
 * Exit:   0 when every check passes, 1 otherwise.
 * Output: sim-output/ (git-ignored): Slack + Teams payload previews, reports.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.fetch = () => { throw new Error('Network access is not allowed in the simulator'); };

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const FIXTURE_PATH = path.join(ROOT, 'sample-payloads', 'latency-fixture.json');
const OUT_DIR = path.join(ROOT, 'sim-output');
const QUIET = process.argv.includes('--quiet');
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; if (!QUIET) console.log(`  ✔ ${label}`); }
  else { failed++; failures.push(label + (detail ? ` -- ${detail}` : '')); console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n▶ ${t}`); };

// ===================================================================== mocks
const TOKENS = {
  HUBSPOT_ACCESS_TOKEN: 'sim-placeholder-hubspot-token',
  WEBHOOK_SHARED_SECRET: 'sim-placeholder-webhook-secret-0123456789',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/TSIM00000/BSIM00000/simplaceholdersecretvalue',
  TEAMS_WEBHOOK_URL: 'https://prod-00.simregion.logic.azure.com/workflows/simplaceholder/triggers/manual/paths/invoke?sig=simplaceholdersig',
};
const PII_PROPS = ['email', 'firstname', 'lastname', 'phone', 'mobilephone', 'address', 'company', 'jobtitle'];
class HttpError extends Error { constructor(status, message) { super(`${status} - ${message}`); this.status = status; } }
const toMs = (v) => { const s = String(v ?? '').trim(); if (!s) return null; if (/^\d{12,14}$/.test(s)) return Number(s); const ms = Date.parse(s); return Number.isFinite(ms) ? ms : null; };
function matches(rec, f) {
  const v = rec.properties[f.propertyName];
  if (f.operator === 'EQ') return String(v ?? '') === String(f.value);
  if (f.operator === 'IN') return f.values.map(String).includes(String(v ?? ''));
  const a = toMs(v), b = Number(f.value);
  if (a === null) return false;
  if (f.operator === 'GTE') return a >= b;
  if (f.operator === 'LT') return a < b;
  throw new HttpError(400, `mock: unsupported operator ${f.operator}`);
}
function makeMocks(opts = {}) {
  const state = { calls: [], posts: [], stamped: {} };
  const contacts = clone(opts.contacts || fixture.contacts);
  const owners = clone(opts.owners || fixture.owners);
  function handle({ method, url, headers, body, node }) {
    const u = new URL(url);
    state.calls.push({ node, method, host: u.host, path: u.pathname, query: u.search, body: clone(body) });
    if (u.host === 'hooks.slack.com') {
      if (opts.failSlack) throw new HttpError(404, 'no_service');
      if (url !== TOKENS.SLACK_WEBHOOK_URL) throw new HttpError(403, 'wrong slack webhook');
      state.posts.push({ channel: 'slack', body: clone(body) });
      return { data: 'ok' };
    }
    if (u.host.endsWith('.logic.azure.com')) {
      if (url !== TOKENS.TEAMS_WEBHOOK_URL) throw new HttpError(401, 'bad sig');
      if (!body || body.type !== 'message' || body.attachments[0].contentType !== 'application/vnd.microsoft.card.adaptive') throw new HttpError(400, 'Workflows expects an Adaptive Card message');
      state.posts.push({ channel: 'teams', body: clone(body) });
      return {};
    }
    if (u.host !== 'api.hubapi.com') throw new HttpError(502, 'unmocked host ' + u.host);
    if (headers.Authorization !== `Bearer ${TOKENS.HUBSPOT_ACCESS_TOKEN}`) throw new HttpError(401, 'bad token');
    if (method === 'POST' && u.pathname === '/crm/v3/objects/contacts/search') {
      if (opts.failSearch) throw new HttpError(500, 'search unavailable');
      if (body.limit > 200) throw new HttpError(400, 'limit > 200');
      const all = contacts.map((r) => ({ ...r, properties: { ...r.properties, ...(state.stamped[r.id] || {}) } }))
        .filter((r) => body.filterGroups.some((g) => g.filters.every((f) => matches(r, f)))).sort((a, b) => Number(a.id) - Number(b.id));
      const start = Number(body.after || 0);
      const page = all.slice(start, start + body.limit).map((r) => ({ id: r.id, properties: Object.fromEntries(body.properties.map((k) => [k, r.properties[k] ?? null])) }));
      const more = opts.endlessPaging || start + body.limit < all.length;
      return { total: opts.fakeTotal || all.length, results: page, ...(more ? { paging: { next: { after: String(start + body.limit) } } } : {}) };
    }
    if (method === 'GET' && u.pathname === '/crm/v3/owners') {
      if (opts.failOwners) throw new HttpError(403, 'MISSING_SCOPES crm.objects.owners.read');
      const start = Number(u.searchParams.get('after') || 0);
      return { results: owners.slice(start, start + 2), ...(start + 2 < owners.length ? { paging: { next: { after: String(start + 2) } } } : {}) };
    }
    if (method === 'POST' && u.pathname === '/crm/v3/objects/contacts/batch/update') {
      for (const i of body.inputs) state.stamped[i.id] = { ...(state.stamped[i.id] || {}), ...i.properties };
      return { status: 'COMPLETE', results: body.inputs.map((i) => ({ id: i.id, properties: i.properties })) };
    }
    throw new HttpError(404, `unmocked route ${method} ${u.pathname}`);
  }
  return { state, handle };
}

// ==================================================================== engine
function evalExpr(template, ctx) {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const t = template.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, { ...ctx, encodeURIComponent, JSON, String, Object, Number }, { timeout: 2000 });
  const single = t.match(/^\{\{([\s\S]*)\}\}$/);
  if (single && !single[1].includes('}}')) return run(single[1]);
  return t.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = run(e); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
}
function runWorkflow({ trigger = 'manual', webhookItem, env = {}, mocks, staticData = {} }) {
  const runData = {};
  const envProxy = new Proxy({}, { get(_t, k) { if (env === 'BLOCKED') throw new Error('access to env vars denied'); return typeof k === 'string' ? env[k] : undefined; } });
  const accessor = (name) => {
    const runs = runData[name];
    if (!runs || !runs.length) throw new Error(`Referenced node "${name}" has not executed`);
    const items = (runs[runs.length - 1][0] || []).map(clone);
    return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
  };
  const ctxFor = (item) => ({ $json: clone(item.json), $: accessor, $env: envProxy });
  function exec(name, items) {
    const node = byName[name];
    let outputs;
    switch (node.type) {
      case 'n8n-nodes-base.manualTrigger': case 'n8n-nodes-base.webhook': case 'n8n-nodes-base.scheduleTrigger':
        outputs = [items]; break;
      case 'n8n-nodes-base.code': {
        const sandbox = {
          $input: { first: () => clone(items[0]), all: () => items.map(clone), item: clone(items[0]) },
          $env: envProxy, $: accessor, $getWorkflowStaticData: () => staticData,
          require: (m) => { throw new Error(`Cannot find module '${m}'`); },
          console: { log() {}, warn() {}, error() {} },
        };
        const res = vm.runInNewContext(`(() => {\n${node.parameters.jsCode}\n})()`, sandbox, { timeout: 20000, filename: `${name}.js` });
        if (!Array.isArray(res)) throw new Error(`Code node "${name}" did not return an array`);
        outputs = [res.map((i) => clone({ json: i.json }))];
        break;
      }
      case 'n8n-nodes-base.if': {
        const t = [], f = [];
        for (const it of items) (evalExpr(node.parameters.conditions.conditions[0].leftValue, ctxFor(it)) === true ? t : f).push(it);
        outputs = [t, f]; break;
      }
      case 'n8n-nodes-base.httpRequest': {
        const out = [];
        const pg = node.parameters.options && node.parameters.options.pagination && node.parameters.options.pagination.pagination;
        for (const it of items) {
          const c = ctxFor(it);
          let url = evalExpr(node.parameters.url, c);
          const headers = Object.fromEntries((node.parameters.headerParameters?.parameters || []).map((h) => [h.name, evalExpr(h.value, c)]));
          let body = node.parameters.sendBody ? JSON.parse(evalExpr(node.parameters.jsonBody, c)) : undefined;
          const send = () => mocks.handle({ method: node.parameters.method || 'GET', url, headers, body, node: name });
          try {
            if (!pg) { out.push({ json: send() }); continue; }
            for (let n = 0; n < pg.maxRequests; n++) {
              const resp = send();
              out.push({ json: resp });
              const rc = { ...c, $response: { body: resp } };
              if (evalExpr(pg.completeExpression, rc) === true) break;
              for (const prm of pg.parameters.parameters) {
                const v = evalExpr(prm.value, rc);
                if (prm.type === 'body') body = { ...body, [prm.name]: v };
                if (prm.type === 'qs') { const uu = new URL(url); uu.searchParams.set(prm.name, v); url = uu.toString(); }
              }
            }
          } catch (e) {
            if (node.onError === 'continueRegularOutput') out.push({ json: { error: { message: e.message, status: e.status } } });
            else throw Object.assign(new Error(`${name}: ${e.message}`), { node: name });
          }
        }
        outputs = [out]; break;
      }
      default: throw new Error(`Engine does not support ${node.type}`);
    }
    (runData[name] = runData[name] || []).push(outputs.map((o) => (o || []).map(clone)));
    const conns = (workflow.connections[name] || {}).main || [];
    outputs.forEach((o, idx) => { if (o && o.length) for (const cn of conns[idx] || []) exec(cn.node, o); });
  }
  let error = null;
  try {
    if (trigger === 'webhook') exec('SLA Profiler Webhook', [{ json: webhookItem }]);
    else if (trigger === 'schedule') exec('Weekly Schedule (Mon 07:53)', [{ json: {} }]);
    else exec('Manual Test Trigger', [{ json: {} }]);
  } catch (e) { error = e; }
  const last = (n) => (runData[n] ? runData[n][runData[n].length - 1][0].map((i) => i.json) : undefined);
  return { runData, error, last, mocks, staticData };
}

// -------------------------------------------------------- reference model
// Independent recomputation of total speed-to-lead and nearest-rank
// percentiles straight from the fixture (wall clock), to cross-check the
// workflow's implementation.
const ms = (s) => (s ? Date.parse(s) : null);
function referenceTotals() {
  const out = [];
  for (const c of fixture.contacts) {
    const p = c.properties;
    const t = [p.first_conversion_date, p.lead_ingested_at, p.lead_enriched_at, p.hubspot_owner_assigneddate, p.hs_sa_first_engagement_date].map(ms);
    if (!t[0] || t.some((x) => Number.isNaN(x)) || t[0] < Date.UTC(2026, 10, 9, 10) || t[0] >= Date.UTC(2026, 10, 16, 10) || !t[4]) continue;
    const present = t.filter((x) => x !== null);
    if (present.some((x, i) => i && x < present[i - 1] - 60000)) continue;
    out.push(Math.round((t[4] - t[0]) / 1000));
  }
  return out.sort((a, b) => a - b);
}
const nearest = (sorted, q) => sorted[Math.ceil(q * sorted.length) - 1];

// -------------------------------------------------------------- env sets
const NOW = '2026-11-16T10:00:00.000Z';
const LIVE = { SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: TOKENS.HUBSPOT_ACCESS_TOKEN, HUBSPOT_PORTAL_ID: '99000001', NOW_OVERRIDE: NOW, WEBHOOK_SHARED_SECRET: TOKENS.WEBHOOK_SHARED_SECRET };
const ARMED = { ...LIVE, DRY_RUN: 'false', NOTIFICATIONS_ENABLED: 'true', NOTIFY_CHANNELS: 'slack,teams', SLACK_WEBHOOK_URL: TOKENS.SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL: TOKENS.TEAMS_WEBHOOK_URL, HUBSPOT_MUTATIONS_ENABLED: 'true' };
const SB = (extra = {}, sd = {}) => runWorkflow({ env: { NOW_OVERRIDE: NOW, ...extra }, mocks: makeMocks(), staticData: sd });
const calcOf = (r) => r.last('Latency Profiler')[0];
const leadOf = (c, id) => c.leads.find((l) => l.id === id);
const cfgOf = (env) => { const r = runWorkflow({ env, mocks: makeMocks() }); return { r, c: r.last('Config & Safety Gate') && r.last('Config & Safety Gate')[0].config }; };
function validateSlack(p) {
  const e = [];
  if (!p.text || !Array.isArray(p.blocks) || p.blocks.length > 50) e.push('text/blocks');
  for (const [i, b] of p.blocks.entries()) {
    if (b.type === 'header' && b.text.text.length > 150) e.push(`#${i} header`);
    if (b.type === 'section' && b.text && b.text.text.length > 3000) e.push(`#${i} text`);
    if (b.type === 'section' && b.fields && (b.fields.length > 10 || b.fields.some((f) => f.text.length > 2000))) e.push(`#${i} fields`);
    if (b.type === 'context' && b.elements.some((x) => x.text.length > 3000)) e.push(`#${i} context`);
  }
  return e;
}

// ====================================================================== main
(function main() {
  console.log('n8n-hubspot-sla-breach-root-cause-latency-profiler :: offline simulator');
  console.log(`workflow: workflow.json (${workflow.nodes.length} nodes)`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ----------------------------------------------------------- 1. structure
  section('1. Workflow structure and static safety checks');
  const names = workflow.nodes.map((n) => n.name);
  check('Node names are unique', new Set(names).size === names.length);
  check('Workflow is inactive on import', workflow.active === false);
  const bad = [];
  for (const [s, c] of Object.entries(workflow.connections)) { if (!byName[s]) bad.push(s); for (const b of c.main || []) for (const x of b) if (!byName[x.node]) bad.push(`${s}->${x.node}`); }
  check('All connections reference existing nodes', bad.length === 0, bad.join(', '));
  const ifs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
  check(`All ${ifs.length} IF nodes wire both outputs`, ifs.every((n) => (workflow.connections[n.name]?.main || []).length === 2 && workflow.connections[n.name].main.every((b) => b.length)));
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); for (const b of workflow.connections[n]?.main || []) for (const c of b) walk(c.node); };
  ['Manual Test Trigger', 'SLA Profiler Webhook', 'Weekly Schedule (Mon 07:53)'].forEach(walk);
  const unreach = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reach.has(n.name)).map((n) => n.name);
  check('Every functional node is reachable from a trigger', unreach.length === 0, unreach.join(', '));
  check('Manual, webhook (POST, immediate response) and weekly schedule triggers exist', byName['SLA Profiler Webhook'].parameters.httpMethod === 'POST' && byName['SLA Profiler Webhook'].parameters.responseMode === 'onReceived' && !!byName['Weekly Schedule (Mon 07:53)']);
  const http = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  const hs = http.filter((n) => n.name !== 'Post Slack / Teams Update');
  check(`${hs.length} HubSpot HTTP nodes authenticate only via {{ $env.HUBSPOT_ACCESS_TOKEN }}`, hs.every((n) => (n.parameters.headerParameters.parameters.find((h) => h.name === 'Authorization') || {}).value === '=Bearer {{ $env.HUBSPOT_ACCESS_TOKEN }}'));
  const post = byName['Post Slack / Teams Update'];
  check('Notification URL comes only from $env; no auto-retry', post.parameters.url === "={{ $json.channel === 'teams' ? $env.TEAMS_WEBHOOK_URL : $env.SLACK_WEBHOOK_URL }}" && !post.retryOnFail);
  check('No stored n8n credentials', workflow.nodes.every((n) => !n.credentials));
  const codeSrc = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => [n.name, n.parameters.jsCode]);
  const writers = codeSrc.filter(([, s]) => /batch\/(update|create|upsert|archive)/.test(s)).map(([n]) => n);
  check('Only "Build SLA Stamp Batches" builds a CRM write request', writers.length === 1 && writers[0] === 'Build SLA Stamp Batches', writers.join(', '));
  check('Lead search stops the run on error (no continue-on-fail)', !byName['HubSpot: Search Leads in Window'].onError);
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const PAT = [[/pat-(na|eu|ap)\d?-[0-9a-f-]{20,}/i, 'HubSpot token'], [/xox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'], [/hooks\.slack\.com\/services\/T[A-Z0-9]+\//, 'Slack webhook URL'], [/logic\.azure\.com\/workflows\//, 'Teams workflow URL'], [/sig=[A-Za-z0-9%_-]{20,}/, 'signed URL'], [/sk-[A-Za-z0-9]{20,}/, 'API key'], [/Bearer [A-Za-z0-9\-_.]{16,}/, 'literal bearer'], [/\+?\d{1,3}[\s.-]\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/, 'phone number']];
  const texts = { 'workflow.json': raw };
  for (const f of ['README.md', 'DISCLAIMER.md', '.env.example', 'sample-payloads/latency-fixture.json']) if (fs.existsSync(path.join(ROOT, f))) texts[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hits = [];
  for (const [f, t] of Object.entries(texts)) for (const [re, l] of PAT) if (re.test(t)) hits.push(`${l} in ${f}`);
  check('No tokens, webhook URLs, signed URLs or phone numbers in shipped files', hits.length === 0, hits.join(', '));
  const emails = [...new Set((raw + texts['sample-payloads/latency-fixture.json']).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
  check('Every email in workflow / fixture uses example.com', emails.length > 0 && emails.every((e) => /@example\.com$/i.test(e)), emails.join(','));
  const exprErr = [];
  const visit = (v, w) => { if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { try { new Function('$json', '$', '$env', '$response', `return (${m[1]});`); } catch (e) { exprErr.push(`${w}: ${e.message}`); } } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${w}.${k}`); };
  workflow.nodes.forEach((n) => visit(n.parameters, n.name));
  check('Every {{ expression }} parses as JavaScript', exprErr.length === 0, exprErr.join('; '));
  const cErr = [];
  for (const [n, s] of codeSrc) { try { new vm.Script(`(() => {\n${s}\n})`); } catch (e) { cErr.push(`${n}: ${e.message}`); } }
  check('Every Code node compiles', cErr.length === 0, cErr.join('; '));
  check('Code nodes call no require() (no network, fs or crypto modules)', codeSrc.every(([, s]) => !/\brequire\s*\(/.test(s)));

  // ------------------------------------------------------ 2. config
  section('2. Safe defaults and config validation');
  const { c: d0 } = cfgOf({ NOW_OVERRIDE: NOW });
  check('Empty env -> SANDBOX_MODE and DRY_RUN on, notifications and CRM writes blocked', d0.sandboxMode && d0.dryRun && !d0.notify.allowedByConfig && !d0.hubspot.stampAllowed);
  check('Default SLA: 30 min total; hops 2 / 5 / 5 / 15 min; wall clock; 60 s skew tolerance', d0.sla.totalMin === 30 && d0.sla.hops.map((h) => h.budgetMin).join() === '2,5,5,15' && d0.sla.clock === 'wall' && d0.sla.skewToleranceSec === 60);
  check('Default window: 168 h ending at now (minute precision)', d0.window.hours === 168 && d0.window.asOfIso === NOW && d0.window.startIso === '2026-11-09T10:00:00.000Z');
  check('Default hop properties are HubSpot built-ins + 2 custom timestamps', d0.hubspot.props.submit === 'first_conversion_date' && d0.hubspot.props.assign === 'hubspot_owner_assigneddate' && d0.hubspot.props.dial === 'hs_sa_first_engagement_date' && d0.hubspot.props.ingest === 'lead_ingested_at');
  const { c: typo } = cfgOf({ NOW_OVERRIDE: NOW, SANDBOX_MODE: 'flase', DRY_RUN: 'nah', NOTIFICATIONS_ENABLED: 'please' });
  check('Typos keep SANDBOX / DRY_RUN on and do not arm notifications', typo.sandboxMode && typo.dryRun && !typo.notify.enabled);
  const { c: blk } = cfgOf('BLOCKED');
  check('Blocked $env -> all safe defaults', blk.envBlocked && blk.sandboxMode && !blk.notify.allowedByConfig);
  const f1 = runWorkflow({ env: { NOW_OVERRIDE: NOW, AS_OF: '2026-11-17T10:00:00Z' }, mocks: makeMocks() });
  check('A future as-of is refused', f1.error && /in the future/.test(f1.error.message));
  const f2 = runWorkflow({ env: { NOW_OVERRIDE: NOW, AS_OF: '2026-11-16 10:00' }, mocks: makeMocks() });
  check('A non-ISO as-of is refused', f2.error && /Invalid as-of/.test(f2.error.message));
  const { c: badc } = cfgOf({ NOW_OVERRIDE: NOW, BUSINESS_HOURS: '18:00-09:00', BUSINESS_HOLIDAYS: '2026-13-01', SLA_UTC_OFFSET_MINUTES: '900', HOP_SLA_INGEST_MINUTES: '-1', WINDOW_HOURS: '0' });
  check('Inverted business hours, bad holiday, offset, budget and window become config errors', badc.configErrors.length >= 5, JSON.stringify(badc.configErrors));
  const { c: sum } = cfgOf({ NOW_OVERRIDE: NOW, TOTAL_SLA_MINUTES: '20' });
  check('Hop budgets above the total SLA raise a warning', sum.warnings.some((w) => /more than TOTAL_SLA_MINUTES/.test(w)));
  const allow = (env) => cfgOf({ ...ARMED, ...env }).c.notify;
  check('Slack URL on a non-allowlisted host is refused', !allow({ NOTIFY_CHANNELS: 'slack', SLACK_WEBHOOK_URL: 'https://hooks.slack.com.attacker.example/x' }).allowedByConfig);
  check('URL with embedded userinfo is refused', !allow({ NOTIFY_CHANNELS: 'slack', SLACK_WEBHOOK_URL: 'https://hooks.slack.com@attacker.example/x' }).allowedByConfig);
  check('Teams URL over plain http is refused', allow({ NOTIFY_CHANNELS: 'teams', TEAMS_WEBHOOK_URL: 'http://prod-00.simregion.logic.azure.com/x' }).blockers.some((b) => /https/.test(b)));
  check('A selected channel without a URL is refused', allow({ NOTIFY_CHANNELS: 'teams', TEAMS_WEBHOOK_URL: '' }).blockers.some((b) => /not set/.test(b)));
  const { r: secretRun } = cfgOf(ARMED);
  check('Config output never contains a token or webhook URL', Object.values(TOKENS).every((s) => !JSON.stringify(secretRun.runData['Config & Safety Gate']).includes(s)));

  // ----------------------------------------------------- 3. webhook
  section('3. Live-mode refusals and webhook authentication');
  const r1 = runWorkflow({ env: { SANDBOX_MODE: 'false', HUBSPOT_PORTAL_ID: '99000001' }, mocks: makeMocks() });
  check('Live without HUBSPOT_ACCESS_TOKEN is refused', r1.error && /HUBSPOT_ACCESS_TOKEN/.test(r1.error.message));
  const wm = makeMocks();
  const r2 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: {}, query: {}, body: {} }, env: LIVE, mocks: wm });
  check('Live webhook without secret is rejected before any API call', r2.error && /Webhook rejected/.test(r2.error.message) && wm.state.calls.length === 0);
  const r3 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: { 'X-SLA-Secret': TOKENS.WEBHOOK_SHARED_SECRET }, query: {}, body: { window_hours: 24 } }, env: LIVE, mocks: makeMocks() });
  check('Valid webhook sets window_hours; secret never copied past the trigger node', !r3.error && r3.last('Config & Safety Gate')[0].config.window.hours === 24 && Object.entries(r3.runData).filter(([n]) => n !== 'SLA Profiler Webhook').every(([, v]) => !JSON.stringify(v).includes(TOKENS.WEBHOOK_SHARED_SECRET)));
  const r4 = runWorkflow({ trigger: 'webhook', webhookItem: { headers: { 'x-sla-secret': TOKENS.WEBHOOK_SHARED_SECRET }, query: {}, body: { window_hours: 'all' } }, env: LIVE, mocks: makeMocks() });
  check('Webhook with an invalid window_hours is refused', r4.error && /window_hours/.test(r4.error.message));
  const r5 = runWorkflow({ trigger: 'schedule', env: { NOW_OVERRIDE: NOW }, mocks: makeMocks() });
  check('Weekly schedule trigger runs (sandbox)', !r5.error && r5.last('SLA Run Report')[0].status === 'DRY_RUN');

  // ---------------------------------------------------- 4. fixture
  section('4. Fixture parity and data minimisation');
  const emb = byName['Load Synthetic Latency Fixture'].parameters.jsCode.match(/const FIXTURE = ([\s\S]*?);\n\nreturn/);
  let parity = false;
  try { parity = JSON.stringify(JSON.parse(emb[1])) === JSON.stringify(fixture); } catch (e) { parity = false; }
  check('Fixture embedded in workflow.json equals sample-payloads/latency-fixture.json', parity);
  check('Fixture flagged synthetic, portal 99000001, owners marked (Mock)', fixture._meta.synthetic && fixture.portalId === '99000001' && fixture.owners.every((o) => /\(Mock\)$/.test(o.lastName)));
  check('Fixture contacts carry no personal-data properties (no name, email, phone)', fixture.contacts.every((c) => PII_PROPS.every((k) => !(k in c.properties))));

  // ---------------------------------------------------------- 5. units
  section('5. Timestamp parsing and SLA clocks');
  const src = byName['Latency Profiler'].parameters.jsCode;
  const grab = (name) => { const s = src.indexOf(`function ${name}(`); let depth = 0; for (let i = src.indexOf('{', s); i < src.length; i++) { if (src[i] === '{') depth++; if (src[i] === '}' && --depth === 0) return src.slice(s, i + 1); } return ''; };
  const mk = (sla) => { const ctx = {}; vm.runInNewContext(`const DAY = 86400000; const S = ${JSON.stringify(sla)}; const B = S.business; const holidaySet = new Set(B.holidays);\n${grab('parseInstant')}\n${grab('clockSec')}\nthis.pi = parseInstant; this.cs = clockSec;`, ctx); return ctx; };
  const wall = mk({ clock: 'wall', business: { openMin: 540, closeMin: 1080, days: [1, 2, 3, 4, 5], holidays: [], utcOffsetMin: 0 } });
  check('parseInstant: ISO and epoch ms accepted; "not-a-date", empty and pre-2000 handled', wall.pi('2026-11-16T10:00:00Z').ms === Date.UTC(2026, 10, 16, 10) && wall.pi('1794823200000').ms === 1794823200000 && wall.pi('not-a-date').invalid && wall.pi('').empty && wall.pi('1999-12-31T00:00:00Z').invalid);
  check('Wall clock: 90 minutes = 5400 s; reversed interval = 0', wall.cs(Date.UTC(2026, 10, 16, 8), Date.UTC(2026, 10, 16, 9, 30)) === 5400 && wall.cs(10, 5) === 0);
  const biz = mk({ clock: 'business', business: { openMin: 540, closeMin: 1080, days: [1, 2, 3, 4, 5], holidays: [], utcOffsetMin: 0 } });
  check('Business clock: Sat 21:00 -> Mon 09:10 counts only Monday 09:00-09:10 (600 s)', biz.cs(Date.UTC(2026, 10, 14, 21), Date.UTC(2026, 10, 16, 9, 10)) === 600);
  check('Business clock: Fri 17:30 -> Mon 09:30 = 30 min Fri + 30 min Mon (3600 s)', biz.cs(Date.UTC(2026, 10, 13, 17, 30), Date.UTC(2026, 10, 16, 9, 30)) === 3600);
  const off = mk({ clock: 'business', business: { openMin: 540, closeMin: 1080, days: [1, 2, 3, 4, 5], holidays: [], utcOffsetMin: -300 } });
  check('UTC offset -300: Mon 13:00Z-15:00Z is 08:00-10:00 local -> 3600 business s', off.cs(Date.UTC(2026, 10, 16, 13), Date.UTC(2026, 10, 16, 15)) === 3600);
  const hol = mk({ clock: 'business', business: { openMin: 540, closeMin: 1080, days: [1, 2, 3, 4, 5], holidays: ['2026-11-16'], utcOffsetMin: 0 } });
  check('Holiday: a Monday holiday contributes 0 business seconds', hol.cs(Date.UTC(2026, 10, 16, 9), Date.UTC(2026, 10, 16, 17)) === 0);

  // ------------------------------------------------- 6. sandbox e2e
  section('6. Sandbox end-to-end: every latency scenario');
  const sb = SB();
  check('Sandbox run completes', !sb.error, sb.error && sb.error.message);
  check('Sandbox run makes ZERO HTTP calls (nothing fetched, posted or written)', sb.mocks.state.calls.length === 0);
  const c = calcOf(sb);
  const expected = {
    990060001: ['MET', null], 990060002: ['MET', null], 990060003: ['BREACHED', 'ENRICHMENT_DELAY'], 990060004: ['BREACHED', 'ENRICHMENT_DELAY'],
    990060005: ['BREACHED', 'INGEST_DELAY'], 990060006: ['BREACHED', 'ASSIGNMENT_DELAY'], 990060007: ['OPEN_BREACHED', 'UNASSIGNED_BOTTLENECK'],
    990060008: ['OPEN_WITHIN_SLA', null], 990060009: ['OPEN_BREACHED', 'MISSED_FIRST_DIAL'], 990060010: ['BREACHED', 'FIRST_DIAL_DELAY'],
    990060011: ['BREACHED', 'FIRST_DIAL_DELAY'], 990060012: ['MET', null], 990060013: ['MET', null], 990060014: ['DATA_ANOMALY', 'DATA_ANOMALY'],
    990060015: ['DATA_ANOMALY', 'DATA_ANOMALY'], 990060017: ['DATA_ANOMALY', 'DATA_ANOMALY'], 990060018: ['MET', null], 990060019: ['MET', null], 990060020: ['MET', null],
  };
  const got = Object.fromEntries(c.leads.map((l) => [l.id, [l.status, l.rootCause]]));
  check('All 19 in-window leads have the expected status and root cause', JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(Object.entries(got).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(expected[k]))));
  check('Out-of-window lead ignored defensively', c.counts.outOfWindowIgnored === 1 && !leadOf(c, '990060016'));
  check('Anomaly codes: non-monotonic, invalid timestamp, missing submit', leadOf(c, '990060014').anomaly === 'NON_MONOTONIC_TIMESTAMPS' && leadOf(c, '990060015').anomaly === 'INVALID_TIMESTAMP' && leadOf(c, '990060017').anomaly === 'MISSING_SUBMIT_TIMESTAMP');
  const l12 = leadOf(c, '990060012');
  check('Skipped enrichment merges into one "enrich+assign" hop with combined 10-min budget', l12.flags.includes('ENRICH_MISSING') && l12.segments.some((s) => s.key === 'enrich+assign' && s.budgetSec === 600 && s.sec === 180));
  const l13 = leadOf(c, '990060013');
  check('30 s clock skew within tolerance is clamped to 0 and flagged', l13.flags.includes('CLOCK_SKEW') && l13.segments.find((s) => s.key === 'enrich').sec === 0);
  const l7 = leadOf(c, '990060007');
  check('Unassigned lead: running assign hop measured to as-of (2h 58m)', l7.segments.some((s) => s.running && s.key === 'assign' && s.sec === 10680) && l7.totalSec === 10800);
  check('Missed first dial: running dial hop measured to as-of', leadOf(c, '990060009').segments.some((s) => s.running && s.key === 'dial' && s.sec === 68200));
  check('In-flight lead within SLA is OPEN_WITHIN_SLA (8 min old)', leadOf(c, '990060008').totalSec === 480);
  check('Root cause = largest overrun hop (lead 3: enrichment 38 m vs 5 m budget)', leadOf(c, '990060003').rootSegment === 'enrich');
  check('Counts: 7 met, 6 breached, 2 open breached, 1 in flight, 3 anomalies', JSON.stringify([c.counts.met, c.counts.breached, c.counts.openBreached, c.counts.openWithinSla, c.counts.anomalies]) === '[7,6,2,1,3]');
  check('SLA adherence = 7 / 15 decided = 46.7% (in-flight excluded)', c.adherencePct === '46.7');
  const ref = referenceTotals();
  check(`Speed-to-lead p50 / p90 / p95 match an independent reference (n=${ref.length})`, c.totalStats.n === ref.length && c.totalStats.p50 === nearest(ref, 0.5) && c.totalStats.p90 === nearest(ref, 0.9) && c.totalStats.p95 === nearest(ref, 0.95) && c.totalStats.max === ref[ref.length - 1], JSON.stringify([c.totalStats, ref]));
  const enrichHop = c.hopStats.find((h) => h.key === 'enrich');
  check('Enrichment hop: 15 measured (merged hop excluded), 2 over budget (13.3%), p90 22 m', enrichHop.n === 15 && enrichHop.overBudget === 2 && enrichHop.overBudgetPct === '13.3' && enrichHop.p90 === 1320);
  const dialHop = c.hopStats.find((h) => h.key === 'dial');
  check('First-dial hop: 13 completed, 2 over budget, +1 open over budget', dialHop.n === 13 && dialHop.overBudget === 2 && dialHop.runningOverBudget === 1);
  check('Bottleneck = assign → first dial (3 of 8 breaches, 37.5%)', c.bottleneck.hop === 'dial' && c.bottleneck.breaches === 3 && c.bottleneck.sharePct === '37.5');
  check('Root-cause ranking sums to all 8 breaches', c.rootCauseRanking.reduce((s, r) => s + r.count, 0) === 8);
  check('Open breaches listed oldest first with HubSpot record links', c.openBreaches.map((o) => o.id).join() === '990060009,990060007' && c.openBreaches[0].url.endsWith('/contacts/99000001/record/0-1/990060009'));
  check('Owner view ranks dial-side breaches first (Morgan / Riley / Jordan)', ['99100003', '99100004', '99100002'].includes(c.owners[0].ownerId) && c.owners[0].dialBreaches + c.owners[0].openMissedDial >= 1);
  check('Source view: PAID_SEARCH adherence computed', c.sources.find((s) => s.source === 'PAID_SEARCH').adherencePct !== null);
  check('Trend vs previous snapshot: adherence -23.3 pts, top cause changed', c.trend.adherencePts === '-23.3' && c.trend.topRootCauseChanged === true);
  check('Guards pass (3/19 = 15.8% anomalies < 20%)', c.guards.passed && c.dataQuality.anomalyPct === '15.8');
  const nb = sb.last('Notification Builder')[0];
  check('Notification blocked in sandbox with reasons; report DRY_RUN', !nb.notifyAllowed && nb.notifyBlockers.some((b) => b.startsWith('SANDBOX_MODE')) && sb.last('SLA Run Report')[0].status === 'DRY_RUN');
  check('Slack Block Kit payload within limits', validateSlack(nb.slackPayload).length === 0, validateSlack(nb.slackPayload).join(';'));
  const tp = nb.teamsPayload;
  check('Teams payload is a Workflows message with an Adaptive Card 1.4 (< 28 KB)', tp.type === 'message' && tp.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive' && tp.attachments[0].content.version === '1.4' && JSON.stringify(tp).length < 28000);
  check('Messages are labelled [SANDBOX] and contain no email addresses', nb.slackPayload.blocks[0].text.text.includes('[SANDBOX]') && !/@example\.com/.test(JSON.stringify([nb.slackPayload, tp])));
  check('Slack message names the bottleneck and includes the hop table', JSON.stringify(nb.slackPayload).includes('Bottleneck: Owner assignment') && JSON.stringify(nb.slackPayload).includes('assign -> first dial'));
  fs.writeFileSync(path.join(OUT_DIR, 'slack-blocks.json'), JSON.stringify({ blocks: nb.slackPayload.blocks }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'teams-adaptive-card.json'), JSON.stringify(tp.attachments[0].content, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'text-preview.txt'), nb.textPreview + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-report.json'), JSON.stringify(sb.last('SLA Run Report')[0], null, 2) + '\n');

  // ---------------------------------------------------------- 7. policies
  section('7. Business clock, budgets, tolerance, window and guards');
  const bz = calcOf(SB({ SLA_CLOCK: 'business' }));
  check('Business clock: weekend lead becomes MET (only Monday 09:00-09:10 counts)', leadOf(bz, '990060011').status === 'MET' && leadOf(bz, '990060011').totalSec === 600);
  check('Business clock: Sunday-assigned, never-dialled lead still OPEN_BREACHED (1 h of Monday)', leadOf(bz, '990060009').status === 'OPEN_BREACHED' && leadOf(bz, '990060009').totalSec === 3600);
  check('Business clock: Monday 07:00 unassigned lead counts from 09:00 (1 h)', leadOf(bz, '990060007').totalSec === 3600);
  const bh = calcOf(SB({ SLA_CLOCK: 'business', BUSINESS_HOLIDAYS: '2026-11-16' }));
  check('Holiday on Monday: weekend lead accrues 0 business seconds', leadOf(bh, '990060011').totalSec === 0);
  const t60 = calcOf(SB({ TOTAL_SLA_MINUTES: '60' }));
  check('TOTAL_SLA_MINUTES=60: 50-min enrichment-delay lead now MET (hop still flagged)', leadOf(t60, '990060003').status === 'MET' && leadOf(t60, '990060003').flags.includes('HOP_OVER_BUDGET'));
  const hb = calcOf(SB({ HOP_SLA_ENRICH_MINUTES: '45' }));
  check('Raising the enrichment budget moves lead 3\'s root cause off enrichment', leadOf(hb, '990060003').rootCause !== 'ENRICHMENT_DELAY');
  const sk = calcOf(SB({ CLOCK_SKEW_TOLERANCE_SECONDS: '10' }));
  check('Skew tolerance 10 s: the 30 s skew becomes a NON_MONOTONIC anomaly', leadOf(sk, '990060013').status === 'DATA_ANOMALY');
  const w24 = calcOf(SB({ WINDOW_HOURS: '24' }));
  check('WINDOW_HOURS=24 keeps only leads from the last day; out-of-window anomalies are not counted', w24.counts.inWindow === 5 && ['990060007', '990060008', '990060009', '990060020'].every((id) => !!leadOf(w24, id)) && !leadOf(w24, '990060003'));
  const ga = calcOf(SB({ MAX_ANOMALY_PCT: '10' }));
  check('Anomaly guard: 15.8% > 10% blocks posting', !ga.guards.passed && ga.guards.failures.some((f) => /MAX_ANOMALY_PCT/.test(f)));
  const gm = calcOf(SB({ MIN_LEADS_TO_POST: '100' }));
  check('MIN_LEADS_TO_POST guard blocks thin samples', !gm.guards.passed);
  const idl = SB({ REP_LABEL: 'id' }).last('Notification Builder')[0];
  check('REP_LABEL=id keeps owner names out of the message', !/Rep \(Mock\)/.test(JSON.stringify(idl.slackPayload)) && JSON.stringify(idl.slackPayload).includes('Owner 99100'));
  const as = calcOf(SB({ AS_OF: '2026-11-16T09:55:00Z' }));
  check('AS_OF earlier: in-flight lead now 3 min old and window shifts accordingly', leadOf(as, '990060008').totalSec === 180 && as.window.asOfIso === '2026-11-16T09:55:00.000Z');

  // --------------------------------------------- 8. live (mocked)
  section('8. Live HubSpot paths with mocks: search, minimisation, pagination, fail-closed');
  const lm = makeMocks();
  const lv = runWorkflow({ env: LIVE, mocks: lm });
  check('Live dry-run completes', !lv.error, lv.error && lv.error.message);
  const sCall = lm.state.calls.find((x) => x.path === '/crm/v3/objects/contacts/search');
  const fl = sCall.body.filterGroups[0].filters;
  check('Search: first_conversion_date in [as-of − 168 h, as-of) as epoch ms', fl[0].propertyName === 'first_conversion_date' && fl[0].operator === 'GTE' && fl[0].value === String(Date.UTC(2026, 10, 9, 10)) && fl[1].operator === 'LT' && fl[1].value === String(Date.UTC(2026, 10, 16, 10)));
  check('Data minimisation: search never requests name, email, phone or company', PII_PROPS.every((k) => !sCall.body.properties.includes(k)));
  check('All live calls are read-only (contact search + owners GET)', lm.state.calls.every((x) => x.path.endsWith('/search') || (x.method === 'GET' && x.path === '/crm/v3/owners')));
  check('Owners fetched with query-string pagination (4 owners, 2 pages)', lm.state.calls.filter((x) => x.path === '/crm/v3/owners').length === 2);
  const lc = calcOf(lv);
  check('Live results equal the sandbox results for every lead the search returns', JSON.stringify(lc.leads.map((l) => [l.id, l.status, l.rootCause, l.totalSec])) === JSON.stringify(c.leads.filter((l) => l.anomaly !== 'MISSING_SUBMIT_TIMESTAMP').map((l) => [l.id, l.status, l.rootCause, l.totalSec])));
  check('Live: a contact without a submit timestamp never matches the window filter', !leadOf(lc, '990060017'));
  check('Live: out-of-window lead excluded by the search itself', lc.counts.outOfWindowIgnored === 0);
  const ls = runWorkflow({ env: { ...LIVE, LIFECYCLE_STAGES: 'lead,marketingqualifiedlead' }, mocks: makeMocks() });
  check('LIFECYCLE_STAGES adds a lifecyclestage IN filter', ls.mocks.state.calls.find((x) => x.path.endsWith('/search')).body.filterGroups[0].filters.some((f) => f.propertyName === 'lifecyclestage' && f.operator === 'IN' && f.values.length === 2));
  const om = runWorkflow({ env: LIVE, mocks: makeMocks({ failOwners: true }) });
  check('Owners scope missing -> labels fall back to owner IDs, run continues', !om.error && calcOf(om).owners.every((o) => /^Owner \d+$/.test(o.label)) && calcOf(om).collectionWarnings.length === 1);
  const fs1 = runWorkflow({ env: LIVE, mocks: makeMocks({ failSearch: true }) });
  check('Fail closed: search error aborts the run (nothing calculated)', fs1.error && /search/i.test(fs1.error.message) && !fs1.last('Latency Profiler'));
  const fs2 = runWorkflow({ env: LIVE, mocks: makeMocks({ fakeTotal: 12000 }) });
  check('Fail closed: > 10,000 matches aborts the run', fs2.error && /10,000/.test(fs2.error.message));
  const fs3 = runWorkflow({ env: LIVE, mocks: makeMocks({ endlessPaging: true }) });
  check('Fail closed: truncated pagination (50 pages) aborts the run', fs3.error && /pagination stopped/i.test(fs3.error.message));
  const many = clone(fixture.contacts);
  for (let i = 0; i < 432; i++) many.push({ id: String(991000000 + i), properties: { first_conversion_date: new Date(Date.UTC(2026, 10, 10, 12) + i * 60000).toISOString(), lead_ingested_at: new Date(Date.UTC(2026, 10, 10, 12) + i * 60000 + 30000).toISOString(), lead_enriched_at: new Date(Date.UTC(2026, 10, 10, 12) + i * 60000 + 90000).toISOString(), hubspot_owner_assigneddate: new Date(Date.UTC(2026, 10, 10, 12) + i * 60000 + 150000).toISOString(), hs_sa_first_engagement_date: new Date(Date.UTC(2026, 10, 10, 12) + i * 60000 + 600000).toISOString(), hubspot_owner_id: '99100001', hs_analytics_source: 'PAID_SEARCH' } });
  const pm = makeMocks({ contacts: many });
  const pr = runWorkflow({ env: LIVE, mocks: pm });
  check('Pagination: 450 leads across 3 pages of 200, no duplicates', !pr.error && pm.state.calls.filter((x) => x.path.endsWith('/search')).length === 3 && calcOf(pr).counts.inWindow === 450 && new Set(calcOf(pr).leads.map((l) => l.id)).size === 450);
  const odd = [{ id: '990069001', properties: { first_conversion_date: '2026-11-16T09:40:00.000Z', lead_ingested_at: '2026-11-16T09:40:30.000Z', hubspot_owner_id: '', hs_analytics_source: 'PAID_SEARCH' } }];
  const eo = calcOf(runWorkflow({ env: LIVE, mocks: makeMocks({ contacts: odd }) }));
  const eo2 = calcOf(runWorkflow({ env: { ...LIVE, ENRICHMENT_OPTIONAL: 'false' }, mocks: makeMocks({ contacts: odd }) }));
  check('Ingested, not enriched, not assigned: UNASSIGNED by default, ENRICHMENT_STALLED when enrichment is mandatory', leadOf(eo, '990069001').segments.at(-1).category === 'UNASSIGNED_BOTTLENECK' && leadOf(eo2, '990069001').segments.at(-1).category === 'ENRICHMENT_STALLED');

  // ------------------------------------- 9. posting, snapshots, stamp
  section('9. Armed posting, duplicate guard, trend snapshot and contact SLA fields (mocked)');
  const sd = {};
  const am = makeMocks();
  const ar = runWorkflow({ env: ARMED, mocks: am, staticData: sd });
  check('Armed run completes and reports POSTED', !ar.error && ar.last('SLA Run Report')[0].status === 'POSTED', ar.error && ar.error.message);
  check('Exactly one Slack and one Teams post', am.state.posts.length === 2 && am.state.posts.map((p) => p.channel).sort().join() === 'slack,teams');
  const built = ar.last('Notification Builder')[0];
  check('Posted payloads are byte-identical to the builder output', JSON.stringify(am.state.posts.find((p) => p.channel === 'slack').body) === JSON.stringify(built.slackPayload) && JSON.stringify(am.state.posts.find((p) => p.channel === 'teams').body) === JSON.stringify(built.teamsPayload));
  check('Webhook URLs never appear in item data', !JSON.stringify(ar.runData).includes(TOKENS.SLACK_WEBHOOK_URL) && !JSON.stringify(ar.runData).includes('simplaceholdersig'));
  check('Snapshot and posting record saved to workflow static data', sd.lastSnapshot.windowEnd === NOW && !!sd.lastPosted[NOW]);
  const upd = am.state.calls.filter((x) => x.path.endsWith('/contacts/batch/update'));
  check('One contact batch update covering all 18 leads returned by the search', upd.length === 1 && upd[0].body.inputs.length === 18);
  const st = (id) => upd[0].body.inputs.find((i) => i.id === id).properties;
  check('SLA fields: status, root cause, minutes (completed only), analysed-at', st('990060003').sla_status === 'BREACHED' && st('990060003').sla_root_cause === 'ENRICHMENT_DELAY' && st('990060003').sla_speed_to_lead_minutes === '50.5' && st('990060007').sla_speed_to_lead_minutes === '' && st('990060001').sla_analyzed_at === NOW);
  const again = runWorkflow({ env: ARMED, mocks: am, staticData: sd });
  check('Second run, same as-of: duplicate post skipped (SKIPPED_ALREADY_POSTED)', am.state.posts.length === 2 && again.last('SLA Run Report')[0].status === 'SKIPPED_ALREADY_POSTED');
  check('Second run: unchanged SLA fields are not rewritten', am.state.calls.filter((x) => x.path.endsWith('/batch/update')).length === 1 && again.last('SLA Stamp Result')[0].attempted === false);
  runWorkflow({ env: { ...ARMED, FORCE_REPOST: 'true' }, mocks: am, staticData: sd });
  check('FORCE_REPOST=true posts again deliberately', am.state.posts.length === 4);
  const nw = runWorkflow({ env: { ...ARMED, NOW_OVERRIDE: '2026-11-16T11:00:00.000Z' }, mocks: makeMocks(), staticData: sd });
  const nwc = calcOf(nw);
  check('Next run: trend computed against the saved snapshot', nwc.trend && nwc.trend.previousWindowEnd === NOW && nw.last('SLA Run Report')[0].status === 'POSTED');
  const fsd = {};
  const fr = runWorkflow({ env: { ...ARMED, NOTIFY_CHANNELS: 'slack' }, mocks: makeMocks({ failSlack: true }), staticData: fsd });
  check('Post failure -> POST_FAILED, no snapshot or posting record saved', fr.last('SLA Run Report')[0].status === 'POST_FAILED' && !fsd.lastSnapshot && !fsd.lastPosted);
  const nm = makeMocks();
  runWorkflow({ env: { ...ARMED, HUBSPOT_MUTATIONS_ENABLED: 'false' }, mocks: nm, staticData: {} });
  check('HUBSPOT_MUTATIONS_ENABLED=false: posts go out, zero CRM writes', nm.state.posts.length === 2 && !nm.state.calls.some((x) => x.path.endsWith('/batch/update')));
  const dm = makeMocks();
  runWorkflow({ env: { ...ARMED, DRY_RUN: 'true' }, mocks: dm, staticData: {} });
  check('DRY_RUN=true with everything else armed: zero posts, zero writes', dm.state.posts.length === 0 && !dm.state.calls.some((x) => x.path.endsWith('/batch/update')));
  const hostile = clone(fixture.owners);
  hostile[2].firstName = '<!channel> *Riley*';
  hostile[2].lastName = '[click](https://evil.example)';
  const hm = makeMocks({ owners: hostile });
  runWorkflow({ env: ARMED, mocks: hm, staticData: {} });
  const sTxt = JSON.stringify(hm.state.posts.find((p) => p.channel === 'slack').body);
  const tTxt = JSON.stringify(hm.state.posts.find((p) => p.channel === 'teams').body);
  check('Hostile CRM names are escaped: no live <!channel> in Slack, no markdown link in Teams', !sTxt.includes('<!channel>') && sTxt.includes('&lt;!channel&gt;') && !tTxt.includes('](https://evil.example)'));
  const allOut = JSON.stringify([ar.runData, am.state.calls.filter((x) => x.host === 'api.hubapi.com')]);
  check('No token or webhook secret appears in any item, report or HubSpot request body', Object.values(TOKENS).every((t) => !allOut.includes(t)));
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-report.json'), JSON.stringify(ar.last('SLA Run Report')[0], null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-call-log.json'), JSON.stringify(am.state.calls.map((x) => ({ node: x.node, method: x.method, host: x.host === 'api.hubapi.com' ? x.host : '(webhook host)', path: x.host === 'api.hubapi.com' ? x.path : '(webhook)' })), null, 2) + '\n');

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  console.log(`Sandbox: adherence ${c.adherencePct}% (${c.counts.met}/${c.counts.met + c.counts.breached + c.counts.openBreached}), speed-to-lead p50 ${c.totalStats.p50}s / p90 ${c.totalStats.p90}s, bottleneck ${c.bottleneck.hop}`);
  console.log('Output written to: sim-output/ (git-ignored)');
  if (failed) { console.log('\nFailures:\n' + failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();
