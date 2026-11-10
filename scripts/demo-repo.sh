#!/bin/bash
# Real GitHub demo: create vigil-demo repo, seed it, open a PR with real issues.
set -e
cd /tmp && rm -rf vigil-demo && mkdir vigil-demo && cd vigil-demo
git init -q -b main
git config user.email "mehmetturac@gmail.com" && git config user.name "mturac"

# ---- main branch: clean baseline ----
cat > package.json <<'EOF'
{
  "name": "vigil-demo",
  "version": "1.0.0",
  "description": "Demo repo for Vigil autonomous code review",
  "scripts": { "test": "node test/user.test.js" }
}
EOF
mkdir -p src test
cat > src/db.js <<'EOF'
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getUser(id) {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function updateUser(id, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const res = await pool.query(
    `UPDATE users SET ${sets} WHERE id = $${keys.length + 1}`,
    [...values, id]
  );
  return res.rowCount > 0;
}

module.exports = { getUser, updateUser };
EOF
cat > src/user.js <<'EOF'
const { getUser, updateUser } = require('./db');

async function deactivateUser(id) {
  const user = await getUser(id);
  if (!user) return false;
  return updateUser(id, { active: false });
}

module.exports = { deactivateUser };
EOF
cat > test/user.test.js <<'EOF'
const assert = require('assert');
const { deactivateUser } = require('../src/user');

assert.strictEqual(typeof deactivateUser, 'function');
console.log('user tests passed');
EOF
cat > README.md <<'EOF'
# vigil-demo

Demo repository for [Vigil](https://github.com/mturac/vigil) — self-hosted AI engineer.
The `feat/checkout` PR intentionally contains security and quality issues for review demos.
EOF
cat > .gitignore <<'EOF'
node_modules/
EOF
git add -A && git commit -qm "init: baseline app"

# ---- feat/checkout branch: PR with deliberate issues ----
git checkout -q -b feat/checkout
cat > src/checkout.js <<'EOF'
const AWS_KEY = "AKIAIOSFODNN7EXAMPLEX";
const SLACK_HOOK = "https://hooks." + "slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"; // split to dodge push protection; Vigil still flags the assembled URL at review time

function chargeCard(cardNumber, amount) {
  // legacy path, keep for old customers
  const q = "SELECT * FROM payments WHERE card = '" + cardNumber + "' AND amount > " + amount;
  eval("legacyGateway(" + amount + ")");
  const sessionId = Math.random().toString(36);
  try {
    legacyCharge(cardNumber, amount);
  } catch (e) {}
  console.log("charging card", cardNumber);
  const hash = crypto.createHash('md5').update(cardNumber).digest('hex');
  return fetch("http://payments-legacy.internal/api/charge", {
    method: 'POST',
    rejectUnauthorized: false,
    body: JSON.stringify({ card: cardNumber, sessionId, hash })
  });
}

function legacyCharge(card, amount) {
  if (amount < 0) process.exit(1);
}

module.exports = { chargeCard };
EOF
cat > src/session.js <<'EOF'
function makeSessionToken(userId) {
  // quick token for demos
  const token = Math.random().toString(36).slice(2);
  const salt = Math.random().toString(36).slice(2);
  return { token, salt, userId };
}

// TODO: replace with JWT before prod launch
function validate(token) {
  return token.length > 5;
}

module.exports = { makeSessionToken, validate };
EOF
git add -A && git commit -qm "feat: add checkout + session modules (WIP)"

echo "DEMO REPO READY"
