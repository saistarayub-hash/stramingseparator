// Appwrite integration — plug-and-play.
//
// Live demo endpoint: https://nyc.cloud.appwrite.io/v1
// You must supply a Project ID + API key (server key). Easiest: in the Appwrite
// console → your project → Overview → Integrations → API keys → "Create API key"
// and tick **Select all** (or at least the Databases/DocumentsDB + Storage scopes).
//
// The app auto-uses Appwrite when configured; otherwise it falls back to the
// local JSON store so you can still try everything with zero setup.
//
// Auto-bootstrap creates (idempotently):
//   Database  streampilot
//   Collection videos / publishes / settings   (each stores a JSON 'payload')
//   Bucket    videos                            (gameplay + clips)
//
// IMPORTANT — Appwrite 2.x compatibility:
//   Appwrite renamed its database product. The legacy "Databases/Collections"
//   API (and its `collections.write` scope) is deprecated; new projects expose
//   the modern **DocumentsDB** API with `documentsdb.*` scopes. This module
//   tries DocumentsDB first and transparently falls back to the legacy
//   Databases API, so it works with old keys AND new "Select all" keys.

import { Client, Storage, Databases, DocumentsDB, ID, Permission, Role, Query } from 'node-appwrite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';

const DB_ID = process.env.APPWRITE_DB_ID || 'streampilot';
const VIDEOS_COLLECTION = 'videos';
const PUBLISHES_COLLECTION = 'publishes';
const SETTINGS_COLLECTION = 'settings';
export const VIDEOS_BUCKET = 'videos';

let client = null;
let sdk = null;
// Which DB API won bootstrap: 'modern' (DocumentsDB) or 'legacy' (Databases).
let dbMode = null;
// The database id actually in use after bootstrap (may differ from the
// configured id if the legacy engine already reserves it).
let activeDbId = null;
// Capability probe results from the last bootstrap attempt — surfaced via
// /api/cloud/status so permission gaps are visible at a glance.
let lastProbe = { modern: null, legacy: null };
let lastWrite = { modern: null, legacy: null };

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

/** Which DB API is active after bootstrap ('modern' | 'legacy' | null). */
export function appwriteMode() {
  return dbMode;
}

/** The database id actually in use after bootstrap (may ≠ configured id). */
export function activeDatabaseId() {
  return activeDbId;
}

/** Which engine can this key actually use? ({modern, legacy} → 'full'|'blocked'|null) */
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
    modern: new DocumentsDB(client), // Appwrite 2.x documents API
    legacy: new Databases(client),   // pre-2.x collections API
    dbId: activeDbId || c.databaseId,
    endpoint: c.endpoint,
  };
  return sdk;
}

/** Public-any read permissions so fetched clips/VODs are shareable. */
export const publicRead = (...extra) => [Permission.read(Role.any()), ...extra];

/* ------------------------------------------------------------------ helpers */
function payloadOf(doc) {
  if (!doc) return null;
  try {
    return typeof doc.payload === 'string' ? JSON.parse(doc.payload) : (doc.payload || {});
  } catch { return {}; }
}
function recordToDoc(record) {
  return { payload: JSON.stringify(record ?? {}) };
}

// The single attribute shared by every collection: a JSON blob so the schema
// never has to change when StreamPilot adds a field.
const PAYLOAD_ATTR_LEGACY = ['payload', 65536];            // key, size (64 KB)
const PAYLOAD_ATTR_MODERN = [{ key: 'payload', type: 'text', required: false }];

/* ------------------------------------------------------------------ bootstrap */
const EXTRA_DB_IDS = ['streampilot-2', 'streampilot-v2'];

// Which configured database ids exist in each engine.
async function pickDatabaseId(a) {
  const found = { modern: null, legacy: null };
  // 1) Prefer the configured id if either engine can see it.
  for (const engine of ['modern', 'legacy']) {
    try { await a[engine].get(a.dbId); found[engine] = a.dbId; }
    catch { /* not visible */ }
  }
  // 2) Otherwise discover an existing id we created earlier (either engine).
  for (const id of EXTRA_DB_IDS) {
    for (const engine of ['modern', 'legacy']) {
      if (found[engine]) continue;
      try { await a[engine].get(id); found[engine] = id; }
      catch { /* not visible */ }
    }
  }
  return found;
}

function isAlreadyExists(e) {
  const hay = `${e.type || ''} ${e.code || ''} ${e.message || ''} ${e.response || ''}`;
  return /already[_ ]?exists|already exist|conflict|duplicate/i.test(hay) || e.code === 409;
}

function isAuthFailure(e) {
  return (e && (e.type === 'general_unauthorized_scope' || e.code === 401));
}

async function engineAuth(a, engine) {
  try {
    await a[engine].list();
    return 'full';
  } catch (e) {
    if (isAuthFailure(e)) return 'blocked';
    throw e;
  }
}

async function createDatabase(a, engine, id) {
  if (engine === 'modern') await a.modern.create(id, id, true);
  else await a.legacy.create(id, id, true);
}

// If a modern-capable key wants a fresh id (because "wanted" is locked by the
// legacy engine), try to create/claim one of our alternate ids on modern.
// Throws (with the underlying error) so callers can report it verbatim.
async function tryModernPick(a, wanted) {
  // Prefer to keep using the wanted id directly on modern if it's actually
  // visible (shouldn't happen here, but be safe).
  try { await a.modern.get(wanted); return { id: wanted, reused: true }; } catch { /* not visible */ }
  let lastErr = null;
  for (const id of EXTRA_DB_IDS) {
    try { await a.modern.get(id); return { id, reused: true }; } catch { /* try creating it */ }
    try { await a.modern.create(id, id, true); return { id, reused: false }; }
    catch (e) {
      if (isAlreadyExists(e)) return { id, reused: true };
      lastErr = e;
    }
  }
  throw (lastErr || new Error('modern engine could not create an alternate database id'));
}

async function ensureModernCollection(a, name) {
  try {
    await a.modern.getCollection(a.dbId, name);
    return false;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    await a.modern.createCollection(a.dbId, ID.custom(name), name, publicRead(), false, true, PAYLOAD_ATTR_MODERN);
    return true;
  }
}

async function ensureLegacyCollection(a, name) {
  try {
    await a.legacy.getCollection(a.dbId, name);
    return false;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    await a.legacy.createCollection(a.dbId, ID.custom(name), name, publicRead());
    try { await a.legacy.createStringAttribute(a.dbId, name, ...PAYLOAD_ATTR_LEGACY, false); }
    catch { /* already exists */ }
    return true;
  }
}

async function ensureBucket() {
  const st = appwrite().storage;
  try {
    await st.getBucket(VIDEOS_BUCKET);
    return false;
  } catch {
    await st.createBucket(
      VIDEOS_BUCKET,
      VIDEOS_BUCKET,
      publicRead(),
      false,                // fileSecurity
      true,                 // enabled
      20 * 1024 * 1024 * 1024, // 20GB max file
      [],                   // allowed extensions (all)
      'none',               // compression
      false,                // encryption
      false,                // antivirus
    );
    return true;
  }
}

/**
 * Create the schema if missing (idempotent). Safe to call on every boot.
 * Negotiates engine (modern DocumentsDB vs legacy Databases) and database id
 * based on what the API key can actually see/create — so it works with
 * Appwrite 2.x keys (documentsdb.* scopes) AND legacy keys (collections.*).
 * @returns {{created:string[], mode:string, databaseId:string}}
 */
export async function bootstrap() {
  const a = appwrite();
  const created = [];
  const wanted = a.dbId;

  // ── decide engine + database id ─────────────────────────────────────────
  const existing = await pickDatabaseId(a);

  // Lightweight capability probe — tell us in plain English which API the key
  // can actually use, before attempting any writes.
  const probeModern = await engineAuth(a, 'modern').catch((e) => `unavailable: ${e.message || e}`);
  const probeLegacy = await engineAuth(a, 'legacy').catch((e) => `unavailable: ${e.message || e}`);
  lastProbe = { modern: probeModern, legacy: probeLegacy };

  if (probeModern === 'blocked' && probeLegacy === 'blocked') {
    throw Object.assign(new Error(
      'The API key cannot read either Appwrite database API (it has NO database scopes).\n' +
      'Fix: Appwrite console → your project → Overview → Integrations → API keys → ' +
      'create a NEW key and tick every "Databases" + "DocumentsDB" + "Storage" scope. ' +
      'Then paste it into APPWRITE_API_KEY on Render and redeploy.'
    ), { code: 401, type: 'general_unauthorized_scope' });
  }
  const modernOk = probeModern === 'full';
  const legacyOk = probeLegacy === 'full';

  if (!existing.modern && !existing.legacy) {
    // Fresh project: try modern first, then legacy.
    try {
      await createDatabase(a, 'modern', wanted);
      dbMode = 'modern'; activeDbId = wanted;
    } catch (e) {
      try {
        await createDatabase(a, 'legacy', wanted);
        dbMode = 'legacy'; activeDbId = wanted;
      } catch (e2) {
        throw Object.assign(new Error(
          `Could not create Appwrite database "${wanted}" with either API.\n` +
          `  modern (DocumentsDB): ${e.message || e}\n` +
          `  legacy (Databases) : ${e2.message || e2}`),
          { code: e2.code || e.code, type: e2.type || e.type, response: e2.response || e.response });
      }
    }
    a.dbId = activeDbId;
    created.push('database:' + activeDbId);
  } else if (existing.modern) {
    // Modern engine can see a database — use it.
    dbMode = 'modern'; activeDbId = existing.modern;
    a.dbId = activeDbId;
  } else {
    // Only legacy can see a database. This is the tricky case: an earlier
    // run created a *legacy* database under the wanted id, which now blocks
    // the modern id namespace. If we're on a modern-capable key, put our
    // data in a fresh id instead of fighting for the locked one.
    const modernOk = async () => {
      try { return await tryModernPick(a, wanted); } catch { return null; }
    };
    const altId = await modernOk();
    if (altId) {
      dbMode = 'modern'; activeDbId = altId;
      a.dbId = activeDbId;
      created.push('database:' + activeDbId);
    } else {
      dbMode = 'legacy'; activeDbId = existing.legacy;
      a.dbId = activeDbId;
    }
  }

  // ── ensure collections on the chosen engine ─────────────────────────────
  const ensureCol = dbMode === 'modern' ? ensureModernCollection : ensureLegacyCollection;
  if (await ensureCol(a, VIDEOS_COLLECTION)) created.push(VIDEOS_COLLECTION);
  if (await ensureCol(a, PUBLISHES_COLLECTION)) created.push(PUBLISHES_COLLECTION);
  if (await ensureCol(a, SETTINGS_COLLECTION)) created.push(SETTINGS_COLLECTION);

  if (await ensureBucket()) created.push('bucket:' + VIDEOS_BUCKET);

  return { created, databaseId: activeDbId, endpoint: a.endpoint, mode: dbMode };
}

// Data-access: whichever API won bootstrap.
function db() {
  const a = appwrite();
  return dbMode === 'modern' ? a.modern : a.legacy;
}

async function listAll(a, collection) {
  const d = db();
  const res = await d.listDocuments(a.dbId, collection, [Query.limit(100)]);
  return (res.documents || []).map(payloadOf)
    .sort((x, y) => ((y.createdAt || y.at || '') > (x.createdAt || x.at || '') ? 1 : -1));
}

/* ------------------------------------------------------------------ video records (cloud) */
export const appVideos = {
  async list() {
    return listAll(appwrite(), VIDEOS_COLLECTION);
  },
  async get(id) {
    try {
      return payloadOf(await db().getDocument(appwrite().dbId, VIDEOS_COLLECTION, id));
    } catch { return null; }
  },
  async set(id, data) {
    const a = appwrite();
    const existing = await this.get(id).catch(() => null);
    const merged = { ...(existing || {}), ...data, id };
    if (existing) {
      return payloadOf(await db().updateDocument(a.dbId, VIDEOS_COLLECTION, id, recordToDoc(merged)));
    }
    return payloadOf(await db().createDocument(a.dbId, VIDEOS_COLLECTION, id, recordToDoc(merged), publicRead()));
  },
  async remove(id) {
    try { await db().deleteDocument(appwrite().dbId, VIDEOS_COLLECTION, id); } catch {}
  },
};

export const appPublishes = {
  async list() {
    return listAll(appwrite(), PUBLISHES_COLLECTION);
  },
  async set(id, data) {
    const a = appwrite();
    const existing = await db().getDocument(a.dbId, PUBLISHES_COLLECTION, id).then(payloadOf).catch(() => null);
    const merged = { ...(existing || {}), ...data, id };
    if (existing) {
      return payloadOf(await db().updateDocument(a.dbId, PUBLISHES_COLLECTION, id, recordToDoc(merged)));
    }
    return payloadOf(await db().createDocument(a.dbId, PUBLISHES_COLLECTION, id, recordToDoc(merged), publicRead()));
  },
};

/* ------------------------------------------------------------------ settings */
export const appSettings = {
  async get() {
    try {
      const res = await db().listDocuments(appwrite().dbId, SETTINGS_COLLECTION, [Query.limit(1)]);
      const doc = res.documents[0];
      if (!doc) return {};
      const v = payloadOf(doc);
      return { value: typeof v === 'object' ? v : {} };
    } catch { return {}; }
  },
  async set(patch) {
    const a = appwrite();
    const cur = await this.get();
    const merged = { ...(cur.value || {}), ...patch };
    const res = await db().listDocuments(a.dbId, SETTINGS_COLLECTION, [Query.limit(1)]);
    const doc = res.documents[0];
    if (doc) return await db().updateDocument(a.dbId, SETTINGS_COLLECTION, doc.$id, recordToDoc(merged));
    return await db().createDocument(a.dbId, SETTINGS_COLLECTION, ID.unique(), recordToDoc(merged), publicRead([Permission.write(Role.any())]));
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
  /** Public download URL for a file id, valid for the bucket's public read. */
  viewUrl(fileId, bucket = VIDEOS_BUCKET) {
    return `${appwrite().endpoint}/storage/buckets/${bucket}/files/${fileId}/download?project=${process.env.APPWRITE_PROJECT_ID || appwriteConfig().projectId}`;
  },
};
