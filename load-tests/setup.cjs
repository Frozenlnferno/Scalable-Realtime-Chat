const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { validateResponse } = require('./benchmark.cjs');

function readAccounts(file, minimum = 2) {
  let accounts;
  try { accounts = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Cannot read accounts; create users.local.json from users.example.json.'); }
  if (!Array.isArray(accounts) || accounts.length < minimum || accounts.some(a => typeof a.username !== 'string' || !a.username.trim() || typeof a.password !== 'string' || !a.password)) {
    throw new Error(`Supply at least ${minimum} accounts with username and password.`);
  }
  if (new Set(accounts.map(a => a.username.trim().toLowerCase())).size !== accounts.length) throw new Error('Test accounts must be distinct.');
  return accounts.map(({ username, password }) => ({ username, password }));
}

function authenticate(account, cognito) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'auth-worker.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('cognito_sign_in_timeout')), 30000);
    child.once('error', () => finish(new Error('cognito_worker_failed')));
    child.once('exit', () => finish(new Error('cognito_worker_failed')));
    child.once('message', result => result.idToken
      ? finish(null, result.idToken)
      : finish(new Error(result.error === 'additional_authentication_challenge' ? result.error : 'cognito_sign_in_failed')));
    child.send({ account, cognito });
  });
}

function validateToken(token, minExpiresAt, cognito) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    if (claims.token_use !== 'id' || !claims.sub || !Number.isFinite(claims.exp) || claims.exp * 1000 <= minExpiresAt) throw new Error();
    if (cognito && claims.aud !== cognito.userPoolClientId) throw new Error();
  } catch { throw new Error('ID token is invalid or expires before this benchmark can finish.'); }
  // Signature verification is performed by the existing authenticated API preflight.
}

async function prepare({ accounts, cognito, target, maxDurationMs, signIn = authenticate, fetchImpl = fetch, pool = false }) {
  const users = [];
  async function request(name, token, pathname, body) {
    const response = await fetchImpl(`${target}${pathname}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return validateResponse(name, response.status, await response.json());
  }
  const prepareAccount = async (_, index) => {
    try {
      const token = await signIn(accounts[index], cognito);
      validateToken(token, Date.now() + maxDurationMs + 60000, cognito);
      const directory = await request('users', token, '/api/users');
      users[index] = { token, id: directory.currentUser.id };
    } catch (error) {
      const reason = error.message === 'additional_authentication_challenge' ? 'requires an additional authentication challenge' : 'sign-in, token lifetime, or API validation failed';
      throw new Error(`Account ${index + 1}: ${reason}. No load was started.`);
    }
  };
  if (pool) await require('./pool.cjs').mapLimit(accounts, 4, prepareAccount);
  else for (let index = 0; index < accounts.length; index++) await prepareAccount(accounts[index], index);
  if (new Set(users.map(u => u.id)).size !== users.length) throw new Error('Accounts did not resolve to distinct application users.');
  for (let a = 0; a < users.length; a++) {
    if (pool && a % 2) continue;
    for (let b = a + 1; b < (pool ? a + 2 : users.length); b++) {
      try {
        const opened = await request('open_conversation', users[a].token, '/api/conversations/direct', { recipientUserId: users[b].id });
        if (pool) {
          users[a].conversationId = users[b].conversationId = opened.conversation.id;
          await request('history', users[a].token, `/api/conversations/${opened.conversation.id}/messages`);
        }
      }
      catch { throw new Error('Conversation preparation failed. No load was started.'); }
    }
  }
  // Recheck after all sign-ins/preparation, not just when each token was obtained.
  for (const user of users) validateToken(user.token, Date.now() + maxDurationMs + 60000, cognito);
  return users;
}

module.exports = { readAccounts, authenticate, validateToken, prepare };
