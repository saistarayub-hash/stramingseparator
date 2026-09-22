// Local mock of the Appwrite REST surface to exercise server/appwrite.js
// bootstrap() negotiation without hitting real Appwrite. Run:
//   node scripts/test-bootstrap.mjs
import http from 'node:http';

function startServer(opts) {
  // opts: { databases: [{id, product, type}], allowed: Set<product>|null (null=all read),
  //         legacyNoCollectionsWrite: bool (401 on legacy collections POST),
  //         quota: number (max databases; default 1) }
  const allowed = opts.allowed || new Set(['tablesdb', 'documentsdb', 'databases', 'storage']);
  const quota = opts.quota ?? 1;
  const legacyNoCollectionsWrite = !!opts.legacyNoCollectionsWrite;
  const databases = opts.databases.map((d) => ({ ...d }));
  const log = { created: [], deleted: [] };

  const srv = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const send204 = () => { res.writeHead(204); res.end(); };
    const path = req.url.split('?')[0];
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(Buffer.concat(body).toString() || 'null'); } catch {}
      const m = req.method;
      const scopeBlock = (missing) => ({ type: 'general_unauthorized_scope', code: 401, message: `missing scopes (["${missing}"])` });

      if (req.url.startsWith('/v1/')) {
        const segs = path.replace(/^\/v1\//, '').split('/').filter(Boolean);
        const products = ['tablesdb', 'documentsdb', 'databases'];
        const product = segs[0];
        if (products.includes(product)) {
          if (!allowed.has(product)) {
            return send(401, scopeBlock(product + (m === 'GET' ? '.read' : '.write')));
          }
          const dbId = segs[1];
          const kind = segs[2]; // tables | collections
          const name = segs[3];
          const action = segs[4]; // rows | documents | attributes

          if (legacyNoCollectionsWrite && product === 'databases' && kind === 'collections' && m === 'POST') {
            return send(401, scopeBlock('collections.write'));
          }

          if (!dbId) {
            if (m === 'GET') {
              return send(200, {
                total: databases.filter((d) => d.product === product).length,
                databases: databases.filter((d) => d.product === product).map((d) => ({ $id: d.id, name: d.id, type: d.type })),
              });
            }
            if (m === 'POST') {
              if (databases.length >= quota) {
                return send(403, { type: 'additional_resource_not_allowed', code: 403, message: 'The maximum number of databases allowed for the selected plan has reached. Upgrade to increase the limit.' });
              }
              const type = { tablesdb: 'tablesdb', documentsdb: 'documentsdb', databases: 'legacy' }[product];
              databases.push({ id: payload.databaseId, name: payload.name, product, type });
              log.created.push(product + ':' + payload.databaseId);
              return send(201, { $id: payload.databaseId, name: payload.name, type });
            }
          }
          if (dbId && !kind) {
            if (m === 'GET') {
              const d = databases.find((x) => x.id === dbId && x.product === product);
              if (d) return send(200, { $id: d.id, name: d.name, type: d.type });
              return send(404, { type: 'database_not_found', code: 404, message: 'DB not found' });
            }
            if (m === 'DELETE') {
              const i = databases.findIndex((x) => x.id === dbId && x.product === product);
              if (i >= 0) { databases.splice(i, 1); log.deleted.push(product + ':' + dbId); }
              return send204();
            }
          }
          if (dbId && kind === 'tables' && !name && m === 'POST') return send(201, { $id: payload.tableId || 't', name: payload.name });
          if (dbId && kind === 'tables' && name && !action && m === 'GET') return send(200, { $id: name, name });
          if (dbId && kind === 'tables' && name && action === 'rows') {
            if (m === 'POST') return send(201, { $id: payload.rowId, data: payload.data });
            if (m === 'GET') return send(200, { total: 0, rows: [] });
          }
          if (dbId && kind === 'collections' && !name && m === 'POST') return send(201, { $id: payload.collectionId || 'c', name: payload.name });
          if (dbId && kind === 'collections' && name && !action && m === 'GET') return send(200, { $id: name, name });
          if (dbId && kind === 'collections' && name && action === 'documents') {
            if (m === 'POST') return send(201, { $id: payload.documentId, ...payload.data });
            if (m === 'GET') return send(200, { total: 0, documents: [] });
          }
          if (dbId && kind === 'collections' && name && action === 'attributes' && m === 'POST') return send(201, { key: payload.key });
        }
        if (segs[0] === 'storage' && segs[1] === 'buckets') {
          if (m === 'GET') return send(200, { total: 0, buckets: [] });
          if (m === 'POST') return send(201, { $id: payload.bucketId, name: payload.name });
        }
      }
      return send(404, { type: 'mock_unhandled', code: 404, message: `unhandled ${m} ${path}` });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, log })));
}

async function freshAppwrite() {
  return import('../server/appwrite.js?ts=' + Date.now().toString(36));
}

function setEnv(port) {
  process.env.APPWRITE_ENDPOINT = `http://127.0.0.1:${port}/v1`;
  process.env.APPWRITE_PROJECT_ID = 'proj';
  process.env.APPWRITE_API_KEY = 'key';
}

async function run() {
  let failures = 0;
  const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) failures++; };

  // A) modern "Select all" key; a tablesdb db already exists → reuse it (no create).
  {
    const { srv, log } = await startServer({ allowed: new Set(['tablesdb', 'documentsdb', 'databases', 'storage']), quota: 1,
      databases: [{ id: 'streampilot_t', name: 'streampilot_t', product: 'tablesdb', type: 'tablesdb' }] });
    setEnv(srv.address().port);
    const aw = await freshAppwrite();
    const res = await aw.bootstrap();
    check('A reuse existing tablesdb', res.mode === 'tables' && res.databaseId === 'streampilot_t' && !res.created.includes('database:'));
    srv.close();
  }

  // B) modern key; stranded legacy db eats the single slot → reclaim + create.
  {
    const { srv, log } = await startServer({ allowed: new Set(['tablesdb', 'documentsdb', 'databases', 'storage']), quota: 1,
      legacyNoCollectionsWrite: true,
      databases: [{ id: 'streampilot', name: 'streampilot', product: 'databases', type: 'legacy' }] });
    setEnv(srv.address().port);
    const aw = await freshAppwrite();
    const res = await aw.bootstrap();
    check('B reclaim stranded legacy then create tablesdb', res.mode === 'tables' && res.databaseId === 'streampilot_t' && log.deleted.includes('databases:streampilot'));
    srv.close();
  }

  // C) legacy-only key; only a legacy db exists → reuse legacy.
  {
    const { srv, log } = await startServer({ allowed: new Set(['databases', 'storage']), quota: 1,
      databases: [{ id: 'streampilot', name: 'streampilot', product: 'databases', type: 'legacy' }] });
    setEnv(srv.address().port);
    const aw = await freshAppwrite();
    const res = await aw.bootstrap();
    check('C legacy-only key reuses legacy db', res.mode === 'legacy' && res.databaseId === 'streampilot');
    srv.close();
  }

  // D) modern key; user-created tablesdb with arbitrary id → adopt it.
  {
    const { srv, log } = await startServer({ allowed: new Set(['tablesdb', 'documentsdb', 'databases', 'storage']), quota: 1,
      databases: [{ id: 'MyStuff', name: 'MyStuff', product: 'tablesdb', type: 'tablesdb' }] });
    setEnv(srv.address().port);
    const aw = await freshAppwrite();
    const res = await aw.bootstrap();
    check('D adopt user-created tablesdb', res.mode === 'tables' && res.databaseId === 'MyStuff' && !log.created.length);
    srv.close();
  }

  // E) brand-new project: 0 databases, modern key → create fresh tablesdb.
  {
    const { srv, log } = await startServer({ allowed: new Set(['tablesdb', 'documentsdb', 'databases', 'storage']), quota: 1, databases: [] });
    setEnv(srv.address().port);
    const aw = await freshAppwrite();
    const res = await aw.bootstrap();
    check('E empty project creates tablesdb', res.mode === 'tables' && res.databaseId === 'streampilot_t' && log.created.includes('tablesdb:streampilot_t'));
    srv.close();
  }

  console.log(failures ? `\n${failures} scenario(s) FAILED` : '\nAll scenarios PASSED');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
