#!/usr/bin/env node
// Trigger a Render deploy and WAIT until it is live (or failed), then verify
// the live app answers. Runs on a GitHub runner (needs secrets.RENDER_API_KEY).
//
//   node scripts/render-deploy.mjs
//
// Writes a SECRET-FREE report to cloud-probe/deploy.txt + deploy.json, and
// exports the detected app URL as APP_URL for any later step via $GITHUB_ENV.
//
// Exit codes: 0 = deployed & verified (or skipped: no RENDER_API_KEY),
//             1 = deploy failed / timed out / unverifiable.
import fs from 'node:fs';

const KEY = process.env.RENDER_API_KEY || '';
const SERVICE_RE = /streampilot/i;
// Which branch the service must build. Defaults to the branch the runner
// checked out (GITHUB_REF_NAME), else the session branch.
const TARGET_BRANCH = process.env.DEPLOY_BRANCH
  || process.env.GITHUB_REF_NAME
  || 'arena/01a0ba1a-stramingseparator';
const POLL_MS = 15000;
const DEPLOY_TIMEOUT_MS = Number(process.env.DEPLOY_TIMEOUT_MS) || 20 * 60 * 1000;
const VERIFY_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS) || 3 * 60 * 1000;

const TS = () => new Date().toISOString();
const lines = [];
const log = (m) => { const l = `[${TS()}] ${m}`; lines.push(l); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { at: TS(), steps: [] };

async function renderApi(p, opts = {}) {
  const res = await fetch(`https://api.render.com/v1${p}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function write() {
  fs.mkdirSync('cloud-probe', { recursive: true });
  fs.writeFileSync('cloud-probe/deploy.txt', lines.join('\n') + '\n');
  fs.writeFileSync('cloud-probe/deploy.json', JSON.stringify(report, null, 2));
}

async function verifyApp(url) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + '/api/status', { redirect: 'follow' });
      const b = await res.text();
      let j = null; try { j = JSON.parse(b); } catch {}
      // After a fresh boot, /api/status reports ok:true. Cloud may still be
      // bootstrapping, so treat the app answering as verified here (the smoke
      // test asserts full cloud health a moment later).
      if (j && j.ok) { report.verified = true; report.statusBody = j; log(`verify OK: ${url}/api/status → ${JSON.stringify(j)}`); return true; }
      log(`verify (status ${res.status}): ${b.slice(0, 80)}`);
    } catch (e) {
      log(`verify attempt failed: ${e.cause?.code || e.message}`);
    }
    await sleep(8000);
  }
  return false;
}

async function main() {
  report.renderKeyPresent = !!KEY;
  if (!KEY) {
    log('RENDER_API_KEY not set — deploy skipped (will still run the smoke test).');
    report.deployed = false;
    report.reason = 'no RENDER_API_KEY secret';
    write();
    process.exit(0);
  }

  // 1) find the service
  const list = await renderApi('/services?limit=100');
  if (list.status !== 200) {
    log(`list services HTTP ${list.status}: ${(list.json?.message || list.text || '').slice(0, 120)}`);
    report.error = `list services HTTP ${list.status}`;
    write(); process.exit(1);
  }
  const services = (list.json || []).map((s) => s.service).filter(Boolean);
  const svc = services.find((s) => SERVICE_RE.test(s.name || '')) || services.find((s) => (s.type || '').includes('web')) || services[0];
  if (!svc) { log('no service found'); report.error = 'no service found'; write(); process.exit(1); }

  const appUrl = svc.serviceDetails?.url || (svc.slug ? `https://${svc.slug}.onrender.com` : 'https://streampilot-ttus.onrender.com');
  report.service = { id: svc.id, name: svc.name, type: svc.type, slug: svc.slug || null, url: appUrl };
  report.allServices = services.map((s) => ({ name: s.name, type: s.type, slug: s.slug }));
  log(`service: ${svc.name} (${svc.id}) ${appUrl}`);
  // hand the app URL to later steps
  const genv = process.env.GITHUB_ENV;
  if (genv) { try { fs.appendFileSync(genv, `APP_URL=${appUrl}\n`); } catch {} }

  // 1b) make sure the service builds OUR branch (a service left on another
  //     branch would deploy the wrong code). Update only if it differs.
  if (svc.repo) {
    const fullSlug = svc.repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    report.repo = fullSlug;
    const curBranch = svc.branch || null;
    report.branchBefore = curBranch;
    if (curBranch !== TARGET_BRANCH) {
      log(`branch: '${curBranch}' → '${TARGET_BRANCH}'`);
      const upd = await renderApi(`/services/${svc.id}`, { method: 'PATCH', body: { branch: TARGET_BRANCH } });
      if (upd.status !== 200 && upd.status !== 202) {
        log(`warn: could not set branch (HTTP ${upd.status}: ${(upd.json?.message || upd.text || '').slice(0, 120)}) — proceeding anyway`);
        report.branchWarn = `HTTP ${upd.status}`;
      } else {
        report.branchAfter = TARGET_BRANCH;
        svc.branch = TARGET_BRANCH;
      }
    } else {
      log(`branch already target: ${TARGET_BRANCH}`);
    }
  }

  // 2) trigger a fresh deploy (clear cache so the branch's code is rebuilt)
  const dep = await renderApi(`/services/${svc.id}/deploys`, { method: 'POST', body: { clearCache: 'clear' } });
  if (dep.status !== 201 && dep.status !== 200) {
    log(`trigger deploy HTTP ${dep.status}: ${(dep.json?.message || dep.text || '').slice(0, 140)}`);
    report.deployed = false;
    report.error = `trigger deploy HTTP ${dep.status}`;
    write(); process.exit(1);
  }
  const deployId = dep.json?.id || null;
  report.deployId = deployId;
  report.commitId = dep.json?.commit?.id || null;
  log(`deploy triggered: ${deployId}${report.commitId ? ' (commit ' + report.commitId.slice(0, 7) + ')' : ''}`);

  // 3) poll until the deploy reaches a terminal state
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let status = dep.json?.status || 'created';
  while (Date.now() < deadline) {
    const d = await renderApi(`/services/${svc.id}/deploys/${deployId}`);
    status = d.json?.status || status;
    report.lastStatus = status;
    log(`deploy status: ${status}${d.json?.finishedAt ? ' (finished ' + d.json.finishedAt + ')' : ''}`);
    if (status === 'live') { report.deployed = true; break; }
    if (status === 'failed' || status === 'canceled' || status === 'deactivated') {
      report.deployed = false;
      report.error = `deploy ${status}`;
      log(`deploy FAILED (${status})`);
      write(); process.exit(1);
    }
    await sleep(POLL_MS);
  }
  if (status !== 'live') {
    report.deployed = false;
    report.error = `deploy timed out after ${DEPLOY_TIMEOUT_MS / 60000} min (last status: ${status})`;
    log('deploy TIMED OUT');
    write(); process.exit(1);
  }

  // 4) confirm the app actually answers
  const ok = await verifyApp(appUrl);
  report.verified = !!ok;
  if (!ok) {
    log('deploy live but app did not answer /api/status in time');
    write(); process.exit(1);
  }

  log('DEPLOY COMPLETE — app is live and answering.');
  write();
  process.exit(0);
}

main().catch((e) => {
  report.error = String((e && e.stack) || e);
  log('FATAL: ' + report.error);
  write();
  process.exit(1);
});
