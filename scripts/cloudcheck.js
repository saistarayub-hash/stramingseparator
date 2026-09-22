#!/usr/bin/env node
// Cloud checker — tests your Appwrite credentials & boots the schema, all in
// one command. Handy before/after deploying, or to confirm a fresh project.
//
//   node scripts/cloudcheck.js            # verify + bootstrap
//   node scripts/cloudcheck.js --ping     # just check credentials reachable
//
// Reads the same places the app does: data/appwrite.json, then .env, then env.

import 'dotenv/config';
import { appwriteConfig, bootstrap } from '../server/appwrite.js';

const justPing = process.argv.includes('--ping');

async function main() {
  const c = appwriteConfig();
  console.log('───────────────────────────────────────────────');
  console.log('  StreamPilot · Appwrite cloud checker');
  console.log('───────────────────────────────────────────────');
  console.log('  endpoint :', c.endpoint);
  console.log('  project  :', c.projectId || '(missing)');
  console.log('  api key  :', c.apiKey ? `standard_${'•'.repeat(12)} (set)` : '(missing)');

  if (!c.projectId || !c.apiKey) {
    console.log('\n✗ Credentials incomplete.');
    console.log('  Add APPWRITE_PROJECT_ID + APPWRITE_API_KEY to .env, or\n  run the dashboard → Settings → Cloud → Connect.');
    process.exit(1);
  }

  // 1) Credentials probe — /health
  try {
    const res = await fetch(c.endpoint.replace(/\/+$/, '') + '/health',
      { headers: { 'X-Appwrite-Project': c.projectId, 'X-Appwrite-Key': c.apiKey } });
    if (!res.ok) {
      console.log(`\n✗ Appwrite rejected the credentials (HTTP ${res.status}).`);
      console.log('  Double-check the Project ID + API key, and that the key has databases + storage scope.');
      process.exit(1);
    }
    const body = await res.text();
    console.log(`\n✓ Credentials valid — Appwrite says: ${body.trim().slice(0, 60)}`);
    if (justPing) process.exit(0);
  } catch (e) {
    console.log(`\n✗ Could not reach ${c.endpoint} — ${e.cause?.code || e.cause?.message || e.message}`);
    console.log('  (This sandbox blocks Appwrite; run on your own machine / VPS / Render.)');
    process.exit(1);
  }

  // 2) Bootstrap the schema (idempotent)
  console.log('\n· Bootstrapping schema…');
  try {
    const out = await bootstrap();
    console.log('✓ Done.');
    console.log('  database :', c.databaseId);
    if (out.created.length) console.log('  created  :', out.created.join(', '));
    else console.log('  everything already exists — schema healthy.');
    console.log('\nYour project is fully linked. Start the dashboard and go! 🎮');
  } catch (e) {
    console.log('✗ Bootstrap failed:', e.message);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
