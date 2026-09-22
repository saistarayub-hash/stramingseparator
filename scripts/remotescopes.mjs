#!/usr/bin/env node
// Remote-hands scope prober — run on a machine with internet (GitHub runner).
// Tests an Appwrite API key against each operation StreamPilot's bootstrap
// needs and reports, per operation, OK or the exact missing scope.
//
// Env: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY

const ENDPOINT = (process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').replace(/\/+$/, '');
const PROJECT = process.env.APPWRITE_PROJECT_ID || '';
const KEY = process.env.APPWRITE_API_KEY || '';

function hdr(method) {
  return {
    'X-Appwrite-Project': PROJECT,
    'X-Appwrite-Key': KEY,
    ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function call(method, path, body) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: hdr(method),
    body: body ? JSON.stringify(body) : undefined,
  });
  let text = '';
  try { text = await res.text(); } catch {}
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

function missingScopes(json) {
  const msg = json?.message || '';
  const m = msg.matchAll(/missing scopes \(\[([^\]]*)\]/g);
  const out = [];
  for (const x of m) out.push(...x[1].replace(/\\?"/g, '').split(','));
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

const tests = [
  { op: 'legacy databases.read',   method: 'GET',  path: '/databases' },
  { op: 'legacy databases.write',  method: 'POST', path: '/databases', body: { databaseId: 'sp_scopeprobe', name: 'sp_scopeprobe' } },
  { op: 'legacy collections.write',method: 'POST', path: '/databases/sp_scopeprobe_legacy/collections', body: { collectionId: 'sp_scopeprobe', name: 'sp_scopeprobe' } },
  { op: 'modern documentsdb.read  ', method: 'GET', path: '/documentsdb' },
  { op: 'modern documentsdb.write ', method: 'POST', path: '/documentsdb', body: { databaseId: 'sp_scopeprobe', name: 'sp_scopeprobe' } },
  { op: 'storage buckets.read     ', method: 'GET', path: '/storage/buckets' },
  { op: 'storage buckets.write    ', method: 'POST', path: '/storage/buckets', body: { bucketId: 'sp_scopeprobe', name: 'sp_scopeprobe' } },
];

console.log('─'.repeat(60));
console.log('  Appwrite scope probe');
console.log(`  endpoint : ${ENDPOINT}`);
console.log(`  project  : ${PROJECT}`);
console.log(`  key      : ${KEY ? KEY.slice(0, 8) + '…' + KEY.slice(-6) : '(none)'}`);
console.log('─'.repeat(60));

let anyBlocked = false;
for (const t of tests) {
  let res;
  try {
    res = await call(t.method, t.path, t.body);
  } catch (e) {
    console.log(`✗ ${t.op.ljust(26)} NETWORK/OTHER: ${e.message}`);
    continue;
  }
  if (res.ok) {
    console.log(`✓ ${t.op.ljust(26)} OK (${res.status})`);
  } else if (res.status === 401 && res.json?.type === 'general_unauthorized_scope') {
    const sc = missingScopes(res.json);
    anyBlocked = true;
    console.log(`✗ ${t.op.ljust(26)} 401 — missing: ${sc.join(', ') || res.json.message}`);
  } else {
    const msg = (res.json?.message || res.text || '').slice(0, 90);
    console.log(`? ${t.op.ljust(26)} ${res.status} ${msg}`);
  }
}

console.log('─'.repeat(60));
const bucketsOk = tests.find((t) => t.op.includes('storage buckets.write')) && null;
console.log(anyBlocked
  ? '🔥 KEY IS MISSING WRITE SCOPES — tick the listed scopes in Appwrite and re-paste the key.'
  : '✅ KEY LOOKS SUFFICIENT — if bootstrap still fails, it is endpoint/project, not scopes.');
