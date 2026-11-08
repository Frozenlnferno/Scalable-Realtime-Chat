const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { parseArgs, parseEnv } = require('node:util');
const { mapLimit } = require('./pool.cjs');

class ProvisioningError extends Error {}
function provisioningReason(error) {
  if (error instanceof ProvisioningError) return error.message;
  // Never surface SDK messages/stacks: they can contain request attributes.
  const reasons = new Map([
    ['CredentialsProviderError', 'Could not load AWS credentials. Configure an AWS profile with aws configure or aws configure sso, then sign in to that profile.'],
    ['AccessDeniedException', 'AWS credentials lack permission for the Cognito administrative operation. Allow cognito-idp:AdminCreateUser and cognito-idp:AdminSetUserPassword on this pool.'],
    ['ExpiredTokenException', 'AWS credentials have expired. Refresh your session or run aws sso login for your profile.'],
    ['ExpiredToken', 'AWS credentials have expired. Refresh your session or run aws sso login for your profile.'],
    ['UnrecognizedClientException', 'AWS credentials are invalid or their session token is missing. Refresh your AWS credentials.'],
    ['InvalidSignatureException', 'AWS rejected the credential signature. Check your credentials and system clock.'],
    ['ResourceNotFoundException', 'Cognito could not find the configured user pool. Check the pool ID and AWS account.'],
    ['InvalidParameterException', 'Cognito rejected the account parameters. Check required pool attributes and email alias format.'],
    ['InvalidPasswordException', 'The generated password does not satisfy the pool password policy.'],
    ['TooManyRequestsException', 'Cognito throttling persisted after bounded retries. Wait, then resume.'],
    ['ThrottlingException', 'AWS throttling persisted after bounded retries. Wait, then resume.'],
    ['LimitExceededException', 'A Cognito limit was reached after bounded retries. Check the pool quotas.'],
    ['UserLambdaValidationException', 'A Cognito Lambda trigger rejected account creation. Check the trigger configuration and logs.'],
    ['InvalidLambdaResponseException', 'A Cognito Lambda trigger returned an invalid response. Check the trigger logs.'],
    ['UnexpectedLambdaException', 'A Cognito Lambda trigger failed. Check the trigger logs.'],
    ['TimeoutError', 'The AWS request timed out. Check network access and retry.'],
  ]);
  if (reasons.has(error?.name)) return reasons.get(error.name);
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'Windows denied an overlapping file replacement or the AWS request. Check directory permissions and retry; resumable progress is preserved.';
  if (error?.code === 'ENOENT') return 'A required local path does not exist. Check the environment and output directory paths.';
  if (error instanceof SyntaxError) return 'A local credentials or provisioning journal file is not valid JSON. Inspect it without deleting existing credentials.';
  return 'Provisioning failed unexpectedly. Check local configuration, network access and the AWS service; existing progress was preserved.';
}

function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, file); return; }
      catch (error) {
        if (attempt === 6 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
        // Antivirus/indexing software can briefly hold a replaced file open.
        Atomics.wait(wait, 0, 0, Math.min(1000, 25 * 2 ** attempt));
      }
    }
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}
async function backoff(fn, pause = ms => new Promise(r => setTimeout(r, ms))) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (error) {
      if (i === 7 || !['TooManyRequestsException', 'ThrottlingException', 'LimitExceededException'].includes(error.name)) throw error;
      await pause(Math.min(10000, 200 * 2 ** i) + Math.floor(Math.random() * 200));
    }
  }
}
async function provision({ count, emailBase, out, poolId, concurrency = 4 }, dependencies = {}) {
  if (!Number.isSafeInteger(count) || count < 2 || !/^[^@\s]+@[^@\s]+$/.test(emailBase) || !poolId) throw new ProvisioningError('Provide count >= 2, --email-base mailbox, and configured Cognito pool.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new ProvisioningError('Provisioning concurrency must be 1..16.');
  out = path.resolve(out);
  if (!out.endsWith('.local.json')) throw new ProvisioningError('Use an ignored *.local.json output file.');
  const progressFile = `${out}.progress.local.json`, lock = `${out}.lock.local`;
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new ProvisioningError('Provisioning lock needs inspection.');
    let alive = true;
    try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new ProvisioningError('Another provisioning process owns this pool.');
    fs.unlinkSync(lock); handle = fs.openSync(lock, 'wx', 0o600);
  }
  fs.writeFileSync(handle, String(process.pid));
  try {
    const existing = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
    if (!Array.isArray(existing) || existing.some(a => !a.username || !a.password) || new Set(existing.map(a => a.username)).size !== existing.length) throw new ProvisioningError('Invalid existing credentials; file preserved.');
    let progress = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : null;
    if (progress && (progress.poolId !== poolId || progress.emailBase !== emailBase)) throw new ProvisioningError('Progress belongs to a different mailbox or pool.');
    if (existing.length && !progress) throw new ProvisioningError('Existing credentials have no provisioning journal; refusing to modify them.');
    if (!progress) progress = { poolId, emailBase, namespace: randomBytes(8).toString('hex'), accounts: [] };
    // Save credentials BEFORE the first remote mutation. A crash between create
    // and permanent-password operations resumes using exactly the same secret.
    while (progress.accounts.length < count) {
      const [local, domain] = emailBase.split('@');
      const username = `${local}+bench-${progress.namespace}-${progress.accounts.length + 1}@${domain}`;
      progress.accounts.push({ username, password: `Aa1!${randomBytes(24).toString('base64url')}`, status: 'planned' });
    }
    for (const account of existing) {
      const entry = progress.accounts.find(a => a.username === account.username);
      if (!entry || entry.password !== account.password || entry.status !== 'ready') throw new ProvisioningError('Credentials and journal differ; files preserved.');
    }
    atomic(progressFile, progress);
    const sdk = dependencies.sdk || require('@aws-sdk/client-cognito-identity-provider');
    const client = dependencies.client || new sdk.CognitoIdentityProviderClient({ region: poolId.split('_')[0], maxAttempts: 1 });
    let saveQueue = Promise.resolve();
    let lastCheckpoint = progress.accounts.filter(a => a.status === 'ready').length;
    const save = (force = false) => {
      // Serial writes plus 25-account checkpoints avoid thousands of large
      // journal replacements. Usernames let a resumed create safely recover
      // the small number of accounts completed since the last checkpoint.
      saveQueue = saveQueue.catch(() => {}).then(() => {
        const ready = progress.accounts.filter(a => a.status === 'ready').length;
        if (!force && ready - lastCheckpoint < 25) return;
        atomic(progressFile, progress);
        atomic(out, progress.accounts.filter(a => a.status === 'ready').map(({ username, password }) => ({ username, password })));
        lastCheckpoint = ready;
      });
      return saveQueue;
    };
    await mapLimit(progress.accounts.slice(0, count), concurrency, async account => {
      if (account.status === 'ready') return;
      let operation = 'AdminCreateUser';
      try {
        if (account.status === 'planned') {
          try {
            await backoff(() => client.send(new sdk.AdminCreateUserCommand({ UserPoolId: poolId, Username: account.username,
              MessageAction: 'SUPPRESS', UserAttributes: [{ Name: 'email', Value: account.username }, { Name: 'email_verified', Value: 'true' }] })));
          } catch (error) {
            // Only this journal's random namespace can be resumed. Never alter
            // an arbitrary pre-existing supplied account.
            if (error.name !== 'UsernameExistsException') throw error;
          }
          account.status = 'created';
        }
        operation = 'AdminSetUserPassword';
        await backoff(() => client.send(new sdk.AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: account.username, Password: account.password, Permanent: true })));
        account.status = 'ready'; await save();
      } catch (error) { throw new ProvisioningError(`${operation}: ${provisioningReason(error)} Rerun the same command to resume. Credentials were preserved.`); }
    }).catch(async error => {
      await save(true);
      throw error;
    });
    await save(true);
    return progress.accounts.filter(a => a.status === 'ready').length;
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
async function main() {
  const { values } = parseArgs({ options: { count: { type: 'string', default: '2500' }, 'email-base': { type: 'string' },
    out: { type: 'string', default: 'users.bench.local.json' }, 'env-file': { type: 'string', default: '.env.local' } } });
  const envFile = path.resolve(__dirname, values['env-file']);
  const env = { ...process.env, ...(fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {}) };
  const total = await provision({ count: Number(values.count), emailBase: values['email-base'] || '', out: values.out,
    poolId: env.CHAT_COGNITO_USER_POOL_ID || env.VITE_COGNITO_USER_POOL_ID });
  console.log(`Account pool ready: ${total} accounts. Credentials saved locally.`);
}
if (require.main === module) main().catch(error => { console.error(`Provisioning stopped: ${provisioningReason(error)}`); process.exitCode = 1; });
module.exports = { atomic, backoff, provision, provisioningReason };
