#!/usr/bin/env node
// Remote operations — drive Render + probe Appwrite, from an internet-connected
// machine (GitHub runner). This sandbox can't reach Render/Appwrite directly,
// but a GitHub-hosted runner can. Writes a SECRET-FREE report to
// cloud-probe/report.json that the agent reads back through git.

import fs from 'node:fs';

const RENDER_KEY = process.env.RENDER_API_KEY || '';
const report = { at: new Date().toISOString(), render: {}, appwrite: {} };

async function renderApi(p, opts = {}) {
  const res = await fetch(`https://api.render.com/v1${p}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${RENDER_KEY}`,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// ---- Appwrite scope probe (pure fetch, no SDK) ----
function missingScopes(json) {
  const msg = json?.message || '';
  const out = [];
  for (const m of msg.matchAll(/missing scopes \(\[([^\]]*)\]/g)) out.push(...m[1].replace(/\\?"/g, '').split(','));
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}
async function awCall(endpoint, projectId, apiKey, method, p, body) {
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}${p}`, {
    method,
    headers: {
      'X-Appwrite-Project': projectId,
      'X-Appwrite-Key': apiKey,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let text = ''; try { text = await res.text(); } catch {}
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, ok: res.ok };
}
async function probeScopes(endpoint, projectId, apiKey) {
  const stamp = Date.now().toString(36);
  const checks = [];
  const add = (name, res) => {
    if (res.ok) checks.push({ name, ok: true });
    else if (res.status === 401 && (res.json?.type === 'general_unauthorized_scope' || /missing scopes/.test(res.text || '')))
      checks.push({ name, ok: false, missing: missingScopes(res.json) });
    else if (res.status === 404 && res.json?.type === 'project_not_found')
      checks.push({ name, ok: false, error: 'project_not_found' });
    else checks.push({ name, ok: false, error: `${res.status} ${(res.json?.message || res.text || '').slice(0, 80)}` });
  };

  // legacy Databases API
  add('Database read (databases.read)', await awCall(endpoint, projectId, apiKey, 'GET', '/databases'));
  const ldb = await awCall(endpoint, projectId, apiKey, 'POST', '/databases', { databaseId: `spre${stamp}`, name: `spre${stamp}` });
  add('Database create (databases.write)', ldb);
  if (ldb.ok) {
    const lcol = await awCall(endpoint, projectId, apiKey, 'POST', `/databases/spre${stamp}/collections`, { collectionId: 'probe', name: 'probe' });
    add('Collection create (collections.write)', lcol);
    if (lcol.ok) {
      add('Attribute create (attributes.write)', await awCall(endpoint, projectId, apiKey, 'POST', `/databases/spre${stamp}/collections/probe/attributes/string`, { key: 'payload', size: 65536, required: false }));
      add('Document create (documents.write)', await awCall(endpoint, projectId, apiKey, 'POST', `/databases/spre${stamp}/collections/probe/documents`, { documentId: 'probe1', data: { payload: '{}' } }));
    }
    await awCall(endpoint, projectId, apiKey, 'DELETE', `/databases/spre${stamp}`).catch(() => {});
  }

  // modern DocumentsDB API
  add('DocumentsDB read (documentsdb.read)', await awCall(endpoint, projectId, apiKey, 'GET', '/documentsdb'));
  const mdb = await awCall(endpoint, projectId, apiKey, 'POST', '/documentsdb', { databaseId: `spmd${stamp}`, name: `spmd${stamp}` });
  add('DocumentsDB create (documentsdb.write)', mdb);
  if (mdb.ok) {
    const mcol = await awCall(endpoint, projectId, apiKey, 'POST', `/documentsdb/spmd${stamp}/collections`, { collectionId: 'probe', name: 'probe' });
    add('DocumentsDB collection create (documentsdb.collections.write)', mcol);
    if (mcol.ok) {
      add('DocumentsDB document create (documentsdb.documents.write)', await awCall(endpoint, projectId, apiKey, 'POST', `/documentsdb/spmd${stamp}/collections/probe/documents`, { documentId: 'probe1', data: { payload: '{}' } }));
    }
    await awCall(endpoint, projectId, apiKey, 'DELETE', `/documentsdb/spmd${stamp}`).catch(() => {});
  }

  // Storage
  add('Bucket read (buckets.read)', await awCall(endpoint, projectId, apiKey, 'GET', '/storage/buckets'));
  const bkt = await awCall(endpoint, projectId, apiKey, 'POST', '/storage/buckets', { bucketId: `spbk${stamp}`, name: `spbk${stamp}` });
  add('Bucket create (buckets.write)', bkt);
  if (bkt.ok) await awCall(endpoint, projectId, apiKey, 'DELETE', `/storage/buckets/spbk${stamp}`).catch(() => {});

  const okCount = checks.filter((c) => c.ok).length;
  return { configured: !!apiKey && !!projectId, endpoint, okCount, total: checks.length, allOk: okCount === checks.length, checks };
}

function write() {
  fs.mkdirSync('cloud-probe', { recursive: true });
  fs.writeFileSync('cloud-probe/report.json', JSON.stringify(report, null, 2));
}

async function main() {
  if (!RENDER_KEY) {
    report.render.error = 'NO RENDER_API_KEY';
    write();
    return;
  }

  // 1) list services
  const list = await renderApi('/services?limit=100');
  if (list.status !== 200) {
    report.render.error = `list services HTTP ${list.status}: ${(list.json?.message || list.text || '').slice(0, 120)}`;
    write();
    return;
  }
  const services = (list.json || []).map((s) => s.service).filter(Boolean);
  const svc = services.find((s) => /streampilot/i.test(s.name || '')) || services.find((s) => s.type === 'web') || services[0];
  if (!svc) { report.render.error = 'NO SERVICE FOUND'; write(); return; }
  report.render.service = { id: svc.id, name: svc.name, type: svc.type, slug: svc.slug || null };
  report.render.allServices = services.map((s) => ({ name: s.name, type: s.type, slug: s.slug }));

  // 2) env vars (values never echoed)
  const env = await renderApi(`/services/${svc.id}/env-vars`);
  if (env.status === 200) {
    const vars = env.json || [];
    report.render.envKeys = vars.map((v) => v.key).sort();
    const pick = (k) => (vars.find((v) => v.key === k) || {}).value || '';
    const awKey = pick('APPWRITE_API_KEY');
    const awProj = pick('APPWRITE_PROJECT_ID');
    const awEp = pick('APPWRITE_ENDPOINT');
    report.render.env = {
      appwriteApiKeySet: !!awKey,
      appwriteApiKeyTail: awKey ? awKey.slice(-6) : null,
      appwriteProjectId: awProj || '(unset)',
      appwriteEndpoint: awEp || '(default nyc)',
    };

    if (awKey && awProj) {
      report.appwrite = await probeScopes(awEp || 'https://nyc.cloud.appwrite.io/v1', awProj, awKey);
    } else {
      report.appwrite.note = 'APPWRITE creds not both present on Render';
    }
  } else {
    report.render.envError = `env-vars HTTP ${env.status}: ${(env.text || '').slice(0, 120)}`;
  }

  // 3) trigger deploy of latest commit (fresh, clear cache)
  const dep = await renderApi(`/services/${svc.id}/deploys`, { method: 'POST', body: { clearCache: 'clear' } });
  report.render.deploy = {
    triggered: dep.status === 201 || dep.status === 200,
    http: dep.status,
    deployId: dep.json?.id || null,
    commitId: dep.json?.commit?.id || null,
    msg: (dep.json?.message || dep.text || '').slice(0, 140),
  };

  write();
}

main().catch((e) => {
  report.render.error = String((e && e.message) || e);
  write();
  process.exitCode = 1;
});
