import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.json');

export const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------- Supabase
let supabase = null;
export function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (url && key) supabase = createClient(url, key);
  return supabase;
}
export const hasSupabase = () => !!getSupabase();

// ---------------------------------------------------------------- Local store
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDb() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const empty = { videos: {}, jobs: {}, publishes: {}, settings: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { videos: {}, jobs: {}, publishes: {}, settings: {} };
  }
}

function writeDb(db) {
  ensureDir();
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

// ---------------------------------------------------------------- Collections
function collection(name) {
  return {
    async list() {
      const db = readDb();
      const rows = Object.values(db[name] || {});
      return rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },
    async get(id) {
      const db = readDb();
      return (db[name] || {})[id] || null;
    },
    async set(id, patch) {
      const db = readDb();
      const existing = (db[name] || {})[id] || {};
      db[name] = db[name] || {};
      db[name][id] = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
      writeDb(db);
      return db[name][id];
    },
    async remove(id) {
      const db = readDb();
      delete (db[name] || {})[id];
      writeDb(db);
    },
  };
}

export const videos = collection('videos');
export const jobs = collection('jobs');
export const publishes = collection('publishes');

export async function getSettings() {
  const db = readDb();
  return db.settings || {};
}
export async function saveSettings(patch) {
  const db = readDb();
  db.settings = { ...(db.settings || {}), ...patch };
  writeDb(db);
  return db.settings;
}
