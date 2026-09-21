// Granular Appwrite scope diagnostician.
//
// Directly probes the EXACT operations StreamPilot's bootstrap needs and
// reports, per operation, whether the current API key is authorized — and if
// not, the precise scope(s) missing. This ends the "which checkbox?" guessing:
// /api/cloud/scopes returns a checklist the dashboard can render directly.
//
// Uses raw fetch (Node 20+), so it works independently of the SDK.

import { appwriteConfig } from './appwrite.js';

let cache = { at: 0, data: null };

function missingScopes(json) {
  const msg = json?.message || '';
  const out = [];
  for (const m of msg.matchAll(/missing scopes \(\[([^\]]*)\]/g)) {
    out.push(...m[1].replace(/\\?"/g, '').split(','));
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

async function call(cfg, method, path, body) {
  const res = await fetch(`${cfg.endpoint.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      'X-Appwrite-Project': cfg.projectId,
      'X-Appwrite-Key': cfg.apiKey,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let text = '';
  try { text = await res.text(); } catch {}
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

function verdict(res) {
  if (res.ok) return { ok: true };
  if (res.status === 401 && (res.json?.type === 'general_unauthorized_scope' || /missing scopes/.test(res.text || ''))) {
    const missing = missingScopes(res.json) || (res.json?.message ? [res.json.message] : []);
    return { ok: false, missing };
  }
  if (res.status === 404 && res.json?.type === 'project_not_found') {
    return { ok: false, error: 'project_not_found' };
  }
  return { ok: false, error: `${res.status} ${(res.json?.message || res.text || '').slice(0, 90)}` };
}

/**
 * Run the full scope probe. Returns an ordered checklist.
 * Cached for 60s to avoid hammering Appwrite on every poll.
 */
export async function probeScopes() {
  const cfg = appwriteConfig();
  if (!cfg.projectId || !cfg.apiKey) {
    return { configured: false, checks: [] };
  }
  if (cache.data && Date.now() - cache.at < 60000) return cache.data;

  const stamp = Date.now().toString(36);
  const legacyDb = `sp_probe_${stamp}`;
  const modernDb = `sp_probe_doc_${stamp}`;
  const bucketId = `sp_probe_buck_${stamp}`;
  const checks = [];
  const add = (name, res) => checks.push({ name, ...verdict(res) });

  // --- TablesDB (CURRENT product) ---
  const tablesDb = `sp_probe_tbl_${stamp}`;
  add('TablesDB — read (tables.read)', await call(cfg, 'GET', '/tablesdb'));
  const tdb = await call(cfg, 'POST', '/tablesdb', { databaseId: tablesDb, name: tablesDb });
  add('TablesDB — create (tables.write)', tdb);
  if (tdb.ok) {
    const ttbl = await call(cfg, 'POST', `/tablesdb/${tablesDb}/tables`, { tableId: 'probe', name: 'probe' });
    add('TablesDB — table create (tables.write)', ttbl);
    if (ttbl.ok) {
      const trow = await call(cfg, 'POST', `/tablesdb/${tablesDb}/tables/probe/rows`, { rowId: 'probe1', data: { payload: '{}' } });
      add('TablesDB — row create (rows.write)', trow);
    }
    await call(cfg, 'DELETE', `/tablesdb/${tablesDb}`).catch(() => {});
  }

  // --- modern DocumentsDB API ---
  add('DocumentsDB — read (documentsdb.read)', await call(cfg, 'GET', '/documentsdb'));
  const mdb = await call(cfg, 'POST', '/documentsdb', { databaseId: modernDb, name: modernDb });
  add('DocumentsDB — create (documentsdb.write)', mdb);
  if (mdb.ok) {
    const mcol = await call(cfg, 'POST', `/documentsdb/${modernDb}/collections`, { collectionId: 'probe', name: 'probe' });
    add('DocumentsDB — collection create (documentsdb.collections.write)', mcol);
    if (mcol.ok) {
      const mdoc = await call(cfg, 'POST', `/documentsdb/${modernDb}/collections/probe/documents`, { documentId: 'probe1', data: { payload: '{}' } });
      add('DocumentsDB — document create (documentsdb.documents.write)', mdoc);
    }
    await call(cfg, 'DELETE', `/documentsdb/${modernDb}`).catch(() => {});
  }

  // --- Storage ---
  add('Storage — buckets read (buckets.read)', await call(cfg, 'GET', '/storage/buckets'));
  const bkt = await call(cfg, 'POST', '/storage/buckets', { bucketId, name: bucketId });
  add('Storage — bucket create (buckets.write)', bkt);
  if (bkt.ok) await call(cfg, 'DELETE', `/storage/buckets/${bucketId}`).catch(() => {});

  const okCount = checks.filter((c) => c.ok).length;
  cache = {
    at: Date.now(),
    data: {
      configured: true,
      endpoint: cfg.endpoint,
      okCount,
      total: checks.length,
      allOk: okCount === checks.length,
      checks,
    },
  };
  return cache.data;
}

export function clearScopeCache() {
  cache = { at: 0, data: null };
}
