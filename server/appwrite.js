// Appwrite integration — plug-and-play.
//
// Live endpoint: https://nyc.cloud.appwrite.io/v1 (or your region subdomain).
// You must supply a Project ID + API key (server key). Easiest: in the Appwrite
// console → your project → Overview → Integrations → API keys → "Create API key"
// and tick **Select all** (or at least the Database + Storage scopes).
//
// The app auto-uses Appwrite when configured; otherwise it falls back to the
// local JSON store so you can still try everything with zero setup.
//
// Auto-bootstrap creates (idempotently):
//   Database  streampilot_t (TablesDB) / streampilot_d (DocumentsDB) / streampilot (legacy)
//   Table/collection videos / publishes / settings   (each stores a JSON 'payload')
//   Bucket    videos                                  (gameplay + clips)
//
// ── Appwrite 2.x compatibility (the important bit) ─────────────────────────
//   Appwrite ships THREE database products, each with its own scopes:
//     • TablesDB    → tables.* / columns.* / rows.*      ← CURRENT product
//     • DocumentsDB → documentsdb.*                       (separate product)
//     • Databases   → collections.* / documents.* / attributes.*  ← DEPRECATED
//   Modern "Select all" keys carry tables/columns/rows (and documentsdb), but
//   NOT the deprecated collections.* scopes — which is why older StreamPilot
//   builds kept failing with "missing scopes ([\"collections.write\"])".
//   This build negotiates all three engines and uses whichever the key allows,
//   preferring TablesDB (the current product).

import { Client, Storage, Databases, DocumentsDB, TablesDB, ID, Permission, Role, Query } from 'node-appwrite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';

const DB_ID = process.env.APPWRITE_DB_ID || 'streampilot';
const VIDEOS_COLLECTION = 'videos';
const PUBLISHES_COLLECTION = 'publishes';
const SETTINGS_COLLECTION = 'settings';
export const VIDEOS_BUCKET = 'videos';

const COLLECTIONS = [VIDEOS_COLLECTION, PUBLISHES_COLLECTION, SETTINGS_COLLECTION];

let client = null;
let sdk = null;
// Which engine won bootstrap: 'tables' | 'documentsdb' | 'legacy'.
let dbMode = null;
// The database id actually in use after bootstrap.
let activeDbId = null;
// Capability probe results from the last bootstrap attempt (per engine).
let lastProbe = { tables: null, documentsdb: null, legacy: null };

// Creds file lives next to the local store (data/appwrite.json).
const CREDS_PATH = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), 'appwrite.json')
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'appwrite.json');

function readCredsFile() {
  try { return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); }
  catch { return {}; }
}

export function appwriteConfig() {
  const file = readCredsFile();
  return {
    endpoint: process.env.APPWRITE_ENDPOINT || file.endpoint || DEFAULT_ENDPOINT,
    projectId: process.env.APPWRITE_PROJECT_ID || file.projectId || '',
    apiKey: process.env.APPWRITE_API_KEY || file.apiKey || '',
    databaseId: DB_ID,
  };
}

export function isConfigured() {
  const c = appwriteConfig();
  return !!(c.projectId && c.apiKey);
}

/** Which DB API is active after bootstrap ('tables' | 'documentsdb' | 'legacy' | null). */
export function appwriteMode() {
  return dbMode;
}

/** The database id actually in use after bootstrap. */
export function activeDatabaseId() {
  return activeDbId;
}

/** Per-engine capability from the last bootstrap ({tables, documentsdb, legacy} → 'full'|'blocked'|null). */
export function engineProbe() {
  return lastProbe;
}

/** Drop cached SDK so the next appwrite() re-reads freshly saved creds. */
export function reloadCreds() {
  sdk = null;
  client = null;
  dbMode = null;
  activeDbId = null;
  lastProbe = { tables: null, documentsdb: null, legacy: null };
}

/** Instantiate (lazily) or throw a friendly error. */
export function appwrite() {
  if (sdk) return sdk;
  const c = appwriteConfig();
  if (!c.projectId || !c.apiKey) {
    throw new Error('Appwrite is not configured yet. Add your Project ID + API key in Settings → Cloud, or via APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env.');
  }
  client = new Client().setEndpoint(c.endpoint).setProject(c.projectId).setKey(c.apiKey);
  sdk = {
    client,
    storage: new Storage(client),
    tables: new TablesDB(client),   // current product (tables/columns/rows)
    modern: new DocumentsDB(client), // documentsdb.*
    legacy: new Databases(client),   // deprecated collections.*
    dbId: activeDbId || c.databaseId,
    endpoint: c.endpoint,
  };
  return sdk;
}

/** Public-any read permissions so fetched clips/VODs are shareable. */
export const publicRead = (...extra) => [Permission.read(Role.any()), ...extra];

/* ------------------------------------------------------------------ helpers */
function decode(record) {
  // record is either a row's `.data`, or a document, both of shape { payload }.
  const raw = record?.payload ?? record?.data?.payload;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
  return raw;
}
function recordToDoc(record) {
  return { payload: JSON.stringify(record ?? {}) };
}

function isAlreadyExists(e) {
  const hay = `${e.type || ''} ${e.code || ''} ${e.message || ''} ${e.response || ''}`;
  return /already[_ ]?exists|already exist|conflict|duplicate/i.test(hay) || e.code === 409;
}
function isAuthFailure(e) {
  return e && (e.type === 'general_unauthorized_scope' || e.code === 401 || /missing scopes/i.test(`${e.message || ''} ${e.response || ''}`));
}
function missingScopesFrom(e) {
  const hay = `${e.message || ''} ${e.response || ''}`;
  const out = [];
  for (const m of hay.matchAll(/missing scopes \(\[([^\]]*)\]/g)) out.push(...m[1].replace(/\\?"/g, '').split(','));
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

function describeErr(e) {
  const missing = missingScopesFrom(e);
  if (missing.length || isAuthFailure(e)) {
    return `API key needs permissions it doesn't have${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`;
  }
  return `${e?.message || e}`;
}

/* ------------------------------------------------------------------ engine map */
// Each engine: how to list/get/create/delete its databases.
// `list` returns a DatabaseList ({ databases: [{ $id, name, type }] }).
const ENGINES = {
  tables: {
    list: (a) => a.tables.list(),
    get: (a, id) => a.tables.get(id),
    create: (a, id) => a.tables.create(id, id, true),
    remove: (a, id) => a.tables.delete(id),
  },
  documentsdb: {
    list: (a) => a.modern.list(),
    get: (a, id) => a.modern.get(id),
    create: (a, id) => a.modern.create(id, id, true),
    remove: (a, id) => a.modern.delete(id),
  },
  legacy: {
    list: (a) => a.legacy.list(),
    get: (a, id) => a.legacy.get(id),
    create: (a, id) => a.legacy.create(id, id, true),
    remove: (a, id) => a.legacy.delete(id),
  },
};
const ENGINE_ORDER = ['tables', 'documentsdb', 'legacy'];

// Database ids this app has ever created. Reused across reboots so we never
// orphan a second database; and — because the Appwrite free plan permits only
// ONE database per project — these are the *only* ids we'll ever auto-delete
// when a stranded one is blocking the modern engine.
const CANDIDATE_IDS = (() => {
  const ids = ['streampilot', 'streampilot_t', 'streampilot_d'];
  if (DB_ID && !ids.includes(DB_ID)) ids.unshift(DB_ID);
  return [...new Set(ids)];
})();

function prettyId(engine) {
  if (engine === 'tables') return 'streampilot_t';
  if (engine === 'documentsdb') return 'streampilot_d';
  return 'streampilot';
}

function isPlanLimitError(e) {
  const hay = `${e?.type || ''} ${e?.code || ''} ${e?.message || ''} ${e?.response || ''}`;
  return /maximum number of databases|database limit|additional_resource_not_allowed|plan has reached|limit.*reached/i.test(hay);
}

// One 'payload' text column/attribute shared by every table/collection, so the
// schema never changes when StreamPilot adds features.
const PAYLOAD_COLUMN = [{ key: 'payload', type: 'text', required: false }];

async function ensureCollection(a, engine, name) {
  if (engine === 'tables') {
    try { await a.tables.getTable(a.dbId, name); return false; }
    catch (e) { if (isAlreadyExists(e)) return false; }
    await a.tables.createTable(a.dbId, ID.custom(name), name, publicRead(), false, true, PAYLOAD_COLUMN);
    return true;
  }
  if (engine === 'documentsdb') {
    try { await a.modern.getCollection(a.dbId, name); return false; }
    catch (e) { if (isAlreadyExists(e)) return false; }
    // DocumentsDB is schemaless JSON — documents carry the `payload` field
    // directly, no attributes/columns to define.
    await a.modern.createCollection(a.dbId, ID.custom(name), name, publicRead(), false, true);
    return true;
  }
  // legacy
  try { await a.legacy.getCollection(a.dbId, name); return false; }
  catch (e) { if (isAlreadyExists(e)) return false; }
  await a.legacy.createCollection(a.dbId, ID.custom(name), name, publicRead());
  try { await a.legacy.createStringAttribute(a.dbId, name, 'payload', 65536, false); } catch { /* exists */ }
  return true;
}

/* ------------------------------------------------------------------ data access (engine-agnostic) */
function dataApi(a) {
  return {
    async list(name) {
      const a2 = appwrite();
      const dbId = a2.dbId;
      if (dbMode === 'tables') {
        const res = await a2.tables.listRows(dbId, name, [Query.limit(100)]);
        return (res.rows || []).map((r) => decode(r));
      }
      if (dbMode === 'documentsdb') {
        const res = await a2.modern.listDocuments(dbId, name, [Query.limit(100)]);
        return (res.documents || []).map(decode);
      }
      const res = await a2.legacy.listDocuments(dbId, name, [Query.limit(100)]);
      return (res.documents || []).map(decode);
    },
    async get(name, id) {
      const a2 = appwrite();
      try {
        if (dbMode === 'tables') return decode(await a2.tables.getRow(a2.dbId, name, id));
        if (dbMode === 'documentsdb') return decode(await a2.modern.getDocument(a2.dbId, name, id));
        return decode(await a2.legacy.getDocument(a2.dbId, name, id));
      } catch { return null; }
    },
    async set(name, id, record) {
      const a2 = appwrite();
      const doc = recordToDoc(record);
      const existing = await this.get(name, id);
      if (dbMode === 'tables') {
        if (existing) return decode(await a2.tables.updateRow(a2.dbId, name, id, doc).then(() => this.get(name, id)));
        return decode(await a2.tables.createRow(a2.dbId, name, id, doc, publicRead()).then(() => this.get(name, id)));
      }
      if (dbMode === 'documentsdb') {
        if (existing) return decode(await a2.modern.updateDocument(a2.dbId, name, id, doc).then(() => this.get(name, id)));
        return decode(await a2.modern.createDocument(a2.dbId, name, id, doc, publicRead()).then(() => this.get(name, id)));
      }
      if (existing) return decode(await a2.legacy.updateDocument(a2.dbId, name, id, doc).then(() => this.get(name, id)));
      return decode(await a2.legacy.createDocument(a2.dbId, name, id, doc, publicRead()).then(() => this.get(name, id)));
    },
    async remove(name, id) {
      const a2 = appwrite();
      try {
        if (dbMode === 'tables') await a2.tables.deleteRow(a2.dbId, name, id);
        else if (dbMode === 'documentsdb') await a2.modern.deleteDocument(a2.dbId, name, id);
        else await a2.legacy.deleteDocument(a2.dbId, name, id);
      } catch { /* ignore */ }
    },
    async first(name) {
      const list = await this.list(name);
      return list[0] || null;
    },
    async upsertFirst(name, record) {
      const a2 = appwrite();
      const doc = recordToDoc(record);
      const rows = await this.list(name);
      const first = rows[0];
      if (first) {
        // find its raw id
        const id = await this.firstId(name);
        if (id) {
          if (dbMode === 'tables') { await a2.tables.updateRow(a2.dbId, name, id, doc); return; }
          if (dbMode === 'documentsdb') { await a2.modern.updateDocument(a2.dbId, name, id, doc); return; }
          await a2.legacy.updateDocument(a2.dbId, name, id, doc);
          return;
        }
      }
      const newId = ID.unique();
      if (dbMode === 'tables') await a2.tables.createRow(a2.dbId, name, newId, doc, publicRead());
      else if (dbMode === 'documentsdb') await a2.modern.createDocument(a2.dbId, name, newId, doc, publicRead());
      else await a2.legacy.createDocument(a2.dbId, name, newId, doc, publicRead());
    },
    async firstId(name) {
      const a2 = appwrite();
      if (dbMode === 'tables') { const r = await a2.tables.listRows(a2.dbId, name, [Query.limit(1)]); return r.rows?.[0]?.$id || null; }
      if (dbMode === 'documentsdb') { const r = await a2.modern.listDocuments(a2.dbId, name, [Query.limit(1)]); return r.documents?.[0]?.$id || null; }
      const r = await a2.legacy.listDocuments(a2.dbId, name, [Query.limit(1)]);
      return r.documents?.[0]?.$id || null;
    },
  };
}

/* ------------------------------------------------------------------ storage */
async function ensureBucket() {
  const st = appwrite().storage;
  try {
    await st.getBucket(VIDEOS_BUCKET);
    return false;
  } catch {
    return createBucketAdaptive(st);
  }
}

/**
 * Create the videos bucket, adapting the maximum file size to whatever the
 * current plan permits. Appwrite validates maximumFileSize to a plan-specific
 * range (the free tier caps it at 50,000,000 bytes = 50 MB) and rejects
 * anything above it — so we parse the allowed ceiling from the server's own
 * error and retry, rather than guessing.
 */
async function createBucketAdaptive(st) {
  // Appwrite's free plan validates maximumFileSize to at most 50,000,000 bytes
  // (~47.7 MiB). Try that ceiling first; if a plan's cap differs, parse its
  // exact allowed maximum from the server's own error and retry once.
  const attempts = [50_000_000];
  let lastErr = null;

  const tryCreate = async (maxFileSize) => {
    if (maxFileSize != null) {
      await st.createBucket(
        VIDEOS_BUCKET, VIDEOS_BUCKET, publicRead(),
        false, true, maxFileSize, [], 'none', false, false,
      );
    } else {
      // Omit maximumFileSize entirely → Appwrite applies its own default.
      await st.createBucket(VIDEOS_BUCKET, VIDEOS_BUCKET, publicRead(), false, true);
    }
    return true;
  };

  for (const size of attempts) {
    try {
      return await tryCreate(size);
    } catch (e) {
      lastErr = e;
      // The server reports the valid range, e.g.
      // "Value must be a valid range between 1 and 50,000,000" — use its max.
      const m = /between\s+1\s+and\s+([\d,]+)/i.exec(`${e?.message || ''} ${e?.response || ''}`);
      const cap = m ? Number(m[1].replace(/,/g, '')) : 0;
      if (cap > 0 && cap !== size) {
        try {
          return await tryCreate(cap);
        } catch (e2) {
          lastErr = e2;
        }
      }
    }
  }

  // Last resort: let Appwrite pick the default size itself.
  return tryCreate(null).catch(() => { throw lastErr; });
}

/* ------------------------------------------------------------------ bootstrap */
/**
 * Negotiate the database the API key can actually write with, create the schema
 * if missing (idempotent), then mark cloud ready.
 *
 * Order of preference: TablesDB (current product) → DocumentsDB → Legacy
 * Databases (deprecated). On each engine:
 *   1. REUSE a database the app already created (id matches our patterns).
 *   2. REUSE any pre-existing database on this engine type when the key can't
 *      create a new one (the free plan allows only ONE database per project,
 *      so we must never assume we can spawn a fresh one — reusing the existing
 *      one is what makes a free account work).
 *   3. Otherwise CREATE a new database. If creation is rejected because the
 *      plan's database quota is full, and the single blocking database is one
 *      of OUR OWN stranded ids, reclaim (delete) it and retry once.
 */
export async function bootstrap() {
  const a = appwrite();
  const created = [];

  let chosen = null;
  const phaseErr = {};

  for (const engine of ENGINE_ORDER) {
    try {
      const result = await settleDatabase(a, engine, created, phaseErr);
      if (!result) { lastProbe[engine] = 'blocked'; continue; }
      for (const name of COLLECTIONS) {
        if (await ensureCollection(a, engine, name)) created.push(name);
      }
      dbMode = engine;
      activeDbId = result;
      a.dbId = result;
      chosen = { engine, id: result };
      lastProbe[engine] = 'full';
      break;
    } catch (e) {
      lastProbe[engine] = 'blocked';
      phaseErr[engine] = phaseErr[engine] || e;
    }
  }

  if (!chosen) {
    const reasons = ENGINE_ORDER
      .filter((e) => phaseErr[e])
      .map((e) => `  ${e}: ${describeErr(phaseErr[e])}`)
      .join('\n');
    const err = phaseErr.tables || phaseErr.documentsdb || phaseErr.legacy || new Error('No usable database');
    throw Object.assign(new Error(
      `Appwrite bootstrap failed — no database is writable with this configuration.\n${reasons}\n` +
      'Most likely fix: Appwrite console → your project (Databases tab) already contains a database; StreamPilot can reuse it — reconnect once from Settings → Cloud. If it lists no writable database, create one API key with "Select all" scopes, or delete the leftover database to free the free-plan single-database slot.'
    ), { code: err.code, type: err.type, response: err.response });
  }

  if (await ensureBucket()) created.push('bucket:' + VIDEOS_BUCKET);

  return { created, databaseId: activeDbId, endpoint: a.endpoint, mode: dbMode };
}

/** Find an id on `engine` we can use: reuse preferred, or existing, or create. */
async function settleDatabase(a, engine, created, phaseErr) {
  const sdkEng = ENGINES[engine];

  // 1) Preferred, app-created ids first (cheap, no list call).
  const preferred = engine === 'tables'
    ? ['streampilot_t', 'streampilot']
    : engine === 'documentsdb'
      ? ['streampilot_d', 'streampilot']
      : ['streampilot'];
  for (const id of preferred) {
    try {
      await sdkEng.get(a, id);
      return id;
    } catch (e) {
      if (isAlreadyExists(e)) return id;
    }
  }

  // 2) Reuse an existing database OF THIS PRODUCT (a TablesDB call can't touch
  //    a legacy database, and vice-versa). Only adopt a matching type.
  const productType = { tables: 'tablesdb', documentsdb: 'documentsdb', legacy: 'legacy' }[engine];
  let found = null;
  try {
    const list = await sdkEng.list(a);
    const databases = list?.databases || [];
    found = databases.find((d) => d.type === productType) || null;
  } catch (e) {
    // Listing may be scope-blocked (e.g. legacy keys without databases.read) —
    // if so this engine cannot reveal or reuse anything; bail out.
    if (isAuthFailure(e)) { phaseErr[engine] = phaseErr[engine] || e; return null; }
  }
  if (found) return found.$id;

  // 3) Create a fresh database.
  const id = prettyId(engine);
  try {
    await sdkEng.create(a, id);
    created.push('database:' + id);
    return id;
  } catch (e) {
    // Quota full? If one of OUR stranded ids can be deleted, reclaim it and retry.
    if (isPlanLimitError(e)) {
      const reclaimed = await reclaimStranded(a);
      if (reclaimed) {
        try {
          await sdkEng.create(a, id);
          created.push('database:' + id);
          return id;
        } catch (e2) {
          phaseErr[engine] = phaseErr[engine] || e2;
          return null;
        }
      }
    }
    phaseErr[engine] = phaseErr[engine] || e;
    return null;
  }
}

/** Delete one of our own stranded databases to free the free-plan slot. */
async function reclaimStranded(a) {
  // Only delete databases whose id matches an id WE created — never a stranger's.
  for (const engine of ENGINE_ORDER) {
    const sdkEng = ENGINES[engine];
    try {
      const list = await sdkEng.list(a);
      const databases = list?.databases || [];
      const stranded = databases.find((d) => CANDIDATE_IDS.includes(d.$id));
      if (stranded) {
        await sdkEng.remove(a, stranded.$id);
        return stranded.$id;
      }
    } catch { /* try next engine */ }
  }
  return null;
}

/* ------------------------------------------------------------------ records */
const api_ = () => dataApi(appwrite());

function sortList(list) {
  return (list || []).sort((x, y) => ((y?.createdAt || y?.at || '') > (x?.createdAt || x?.at || '') ? 1 : -1));
}

export const appVideos = {
  async list() { return sortList(await api_().list(VIDEOS_COLLECTION)); },
  async get(id) { return api_().get(VIDEOS_COLLECTION, id); },
  async set(id, data) {
    const existing = await this.get(id);
    const merged = { ...(existing || {}), ...data, id };
    return api_().set(VIDEOS_COLLECTION, id, merged);
  },
  async remove(id) { return api_().remove(VIDEOS_COLLECTION, id); },
};

export const appPublishes = {
  async list() { return sortList(await api_().list(PUBLISHES_COLLECTION)); },
  async set(id, data) {
    const existing = await api_().get(PUBLISHES_COLLECTION, id);
    const merged = { ...(existing || {}), ...data, id };
    return api_().set(PUBLISHES_COLLECTION, id, merged);
  },
};

export const appSettings = {
  async get() {
    try {
      const rec = await api_().first(SETTINGS_COLLECTION);
      return { value: (rec && typeof rec === 'object') ? rec : {} };
    } catch { return {}; }
  },
  async set(patch) {
    const cur = await this.get();
    const merged = { ...(cur.value || {}), ...patch };
    return api_().upsertFirst(SETTINGS_COLLECTION, merged);
  },
};

/* ------------------------------------------------------------------ files */
export const appFiles = {
  async upload(localPath, { bucket = VIDEOS_BUCKET, name, type = 'video/mp4', fileId } = {}) {
    const storage = appwrite().storage;
    const fsNode = await import('node:fs');
    const buf = fsNode.readFileSync(localPath);
    const blob = new File([buf], name || 'clip.mp4', { type });
    const fid = fileId || ID.unique();
    await storage.createFile(bucket, fid, blob, publicRead());
    return { fileId: fid, bucket };
  },
  viewUrl(fileId, bucket = VIDEOS_BUCKET) {
    return `${appwrite().endpoint}/storage/buckets/${bucket}/files/${fileId}/download?project=${process.env.APPWRITE_PROJECT_ID || appwriteConfig().projectId}`;
  },
};
