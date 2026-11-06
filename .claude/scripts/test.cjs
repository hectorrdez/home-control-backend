#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { run, checkUrl } = require('./_lib.cjs');

// API_PORT from the project .env (create-project API scaffold default: 3002).
function envPort() {
  try {
    const m = fs.readFileSync('.env', 'utf8').match(/^\s*API_PORT\s*=\s*"?(\d+)"?/m);
    if (m) return m[1];
  } catch {}
  return '3002';
}

// ============ EDIT FOR YOUR PROJECT ============
// Override with HEALTH_URL=... ; default matches the create-project API scaffold.
const HEALTH_URL = process.env.HEALTH_URL || `http://localhost:${envPort()}/api/health`;
const BRUNO_DIR = 'tests/bruno';
const BRUNO_ENV = 'local';
// ==============================================

(async () => {
  console.log('[1/3] Typecheck (tsc --noEmit)...');
  if (run('npx', ['tsc', '--noEmit']) !== 0) {
    console.log('FAIL: typecheck');
    process.exit(1);
  }

  console.log('[2/3] API reachable?');
  if (!(await checkUrl(HEALTH_URL))) {
    console.log(`PRECONDITION: API not reachable at ${HEALTH_URL}. Start the server, then retry. This is NOT a regression.`);
    process.exit(2);
  }

  console.log('[3/3] Bruno collection (regression)...');
  // Bruno CLI 2.x runs only from the collection root and has no --recursive;
  // use -r from inside the collection. Repo .env is passed so {{process.env.API_TOKEN}} resolves.
  const repoEnv = { ...process.env, ...require('dotenv').parse(fs.readFileSync('.env')) };
  if (run('npx', ['@usebruno/cli', 'run', '--env', BRUNO_ENV, '-r'], { cwd: BRUNO_DIR, env: repoEnv }) !== 0) {
    console.log('FAIL: one or more requests failed');
    process.exit(1);
  }

  console.log('PASS');
  process.exit(0);
})();
