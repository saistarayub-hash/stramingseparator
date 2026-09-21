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
// Each engine: how to list/get/create its database, and a preferred id that
// won't collide with the other engines' namespaces.
const ENGINES = {
  tables: {
    dbIds: ['streampilot_t'],
    async createDb(a, id) { await a.tables.create(id, id, true); },
    async getDb(a, id) { await a.tables.get(id); },
  },
  documentsdb: {
    dbIds: ['streampilot_d'],
    async createDb(a, id) { await a.modern.create(id, id, true); },
    async getDb(a, id) { await a.modern.get(id); },
  },
  legacy: {
    dbIds: ['streampilot'],
    async createDb(a, id) { await a.legacy.create(id, id, true); },
    async getDb(a, id) { await a.legacy.get(id); },
  },
};
const ENGINE_ORDER = ['tables', 'documentsdb', 'legacy'];

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
    await a.modern.createCollection(a.dbId, ID.custom(name), name, publicRead(), false, true, PAYLOAD_COLUMN);
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
    await st.createBucket(
      VIDEOS_BUCKET, VIDEOS_BUCKET, publicRead(),
      false, true, 20 * 1024 * 1024 * 1024, [], 'none', false, false,
    );
    return true;
  }
}

/* ------------------------------------------------------------------ bootstrap */
/**
 * Negotiate the engine the API key can actually write with, create the schema
 * if missing (idempotent), then mark cloud ready. Prefers TablesDB (current
 * product), falling back to DocumentsDB then the deprecated Databases API.
 */
export async function bootstrap() {
  const a = appwrite();
  const created = [];

  let chosen = null;
  let phaseErr = {};

  outer:
  for (const engine of ENGINE_ORDER) {
    const cfg = ENGINES[engine];
    let id = null;
    // 1) settle on (or create) a database id for this engine
    for (const cid of cfg.dbIds) {
      try {
        await cfg.getDb(a, cid);
        id = cid;
        break;
      } catch (e) {
        if (isAlreadyExists(e)) { id = cid; break; }
        try {
          await cfg.createDb(a, cid);
          id = cid;
          created.push('database:' + cid);
          break;
        } catch (e2) {
          if (isAlreadyExists(e2)) { id = cid; break; }
          phaseErr[engine] = phaseErr[engine] || e2;
        }
      }
    }
    if (!id) { lastProbe[engine] = 'blocked'; continue; }

    // 2) ensure all collections/tables are writable on this engine
    try {
      for (const name of COLLECTIONS) {
        if (await ensureCollection(a, engine, name)) created.push(name);
      }
      dbMode = engine;
      activeDbId = id;
      a.dbId = id;
      chosen = { engine, id };
      lastProbe[engine] = 'full';
      break outer;
    } catch (e) {
      lastProbe[engine] = 'blocked';
      phaseErr[engine] = phaseErr[engine] || e;
    }
  }

  for (const e of ENGINE_ORDER) {
    if (!lastProbe[e] && chosen?.engine !== e) lastProbe[e] = 'blocked';
    if (chosen?.engine === e) lastProbe[e] = 'full';
  }

  if (!chosen) {
    const reasons = ENGINE_ORDER
      .filter((e) => phaseErr[e])
      .map((e) => `  ${e}: ${describeErr(phaseErr[e])}`)
      .join('\n');
    const err = phaseErr.tables || phaseErr.documentsdb || phaseErr.legacy || new Error('No usable engine');
    throw Object.assign(new Error(
      `Appwrite bootstrap failed — no database engine is writable with this API key.\n${reasons}\n` +
      'Fix: Appwrite console → your project → Overview → Integrations → API keys → create a NEW key and tick the "Database" + "Storage" write scopes (tables.write, columns.write, rows.write, databases.write — or Select all). Then paste it into APPWRITE_API_KEY on Render and redeploy.'
    ), { code: err.code, type: err.type, response: err.response });
  }

  if (await ensureBucket()) created.push('bucket:' + VIDEOS_BUCKET);

  return { created, databaseId: activeDbId, endpoint: a.endpoint, mode: dbMode };
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
