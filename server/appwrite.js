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
// Which DB API won bootstrap: 'documentsdb' (modern) or 'legacy'.
let dbMode = null;

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

/** Which DB API is active after bootstrap ('documentsdb' | 'legacy' | null). */
export function appwriteMode() {
  return dbMode;
}

/** Drop cached SDK so the next appwrite() re-reads freshly saved creds. */
export function reloadCreds() {
  sdk = null;
  client = null;
  dbMode = null;
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
    dbId: c.databaseId,
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
function isAlreadyExists(e) {
  const hay = `${e.type || ''} ${e.code || ''} ${e.message || ''} ${e.response || ''}`;
  return /already[_ ]?exists|already exist|conflict|duplicate/i.test(hay) || e.code === 409;
}

async function ensureModernDatabase(a) {
  try {
    await a.modern.get(a.dbId);
    return false; // exists (or migrated legacy db) — reuse it
  } catch (e) {
    if (isAlreadyExists(e)) return false; // id occupied by a legacy-created db — reuse it
    await a.modern.create(a.dbId, a.dbId, true); // databaseId, name, enabled → serverless spec
    return true;
  }
}

async function ensureLegacyDatabase(a) {
  try {
    await a.legacy.get(a.dbId);
    return false;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    await a.legacy.create(a.dbId, a.dbId, true);
    return true;
  }
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
 * Tries the modern DocumentsDB API first, then the legacy Databases API.
 * @returns {{created:string[], mode:string}} names of things created
 */
export async function bootstrap() {
  const a = appwrite();
  const created = [];
  let modernError = null;
  let legacyError = null;

  // 1) Modern DocumentsDB path (Appwrite 2.x keys).
  try {
    if (await ensureModernDatabase(a)) created.push('database:' + a.dbId);
    if (await ensureModernCollection(a, VIDEOS_COLLECTION)) created.push(VIDEOS_COLLECTION);
    if (await ensureModernCollection(a, PUBLISHES_COLLECTION)) created.push(PUBLISHES_COLLECTION);
    if (await ensureModernCollection(a, SETTINGS_COLLECTION)) created.push(SETTINGS_COLLECTION);
    dbMode = 'documentsdb';
  } catch (e) {
    modernError = e;
    dbMode = null;
  }

  // 2) Legacy fallback (pre-2.x keys / projects without DocumentsDB).
  if (!dbMode) {
    try {
      if (await ensureLegacyDatabase(a)) created.push('database:' + a.dbId);
      if (await ensureLegacyCollection(a, VIDEOS_COLLECTION)) created.push(VIDEOS_COLLECTION);
      if (await ensureLegacyCollection(a, PUBLISHES_COLLECTION)) created.push(PUBLISHES_COLLECTION);
      if (await ensureLegacyCollection(a, SETTINGS_COLLECTION)) created.push(SETTINGS_COLLECTION);
      dbMode = 'legacy';
    } catch (e) {
      legacyError = e;
    }
  }

  if (!dbMode) {
    // Neither API usable — surface the most useful error (prefer the modern one).
    const err = modernError || legacyError;
    const detail = modernError && legacyError
      ? `${modernError.message || modernError}  ·  (legacy also failed: ${legacyError.message || legacyError})`
      : (err.message || String(err));
    throw Object.assign(new Error(detail), { code: err.code, type: err.type, response: err.response });
  }

  if (await ensureBucket()) created.push('bucket:' + VIDEOS_BUCKET);

  return { created, databaseId: a.dbId, endpoint: a.endpoint, mode: dbMode };
}

// Data-access: whichever API won bootstrap.
function db() {
  const a = appwrite();
  return dbMode === 'documentsdb' ? a.modern : a.legacy;
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
