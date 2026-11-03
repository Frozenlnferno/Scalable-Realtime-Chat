const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runBenchmark } = require('../bench.cjs');
const { startFixture } = require('./fixtures.cjs');

// Real CLI + YAML integration, with shortened timing only in dependency-injected
// local fixtures. Production profiles and minimum hold are never changed.
for (const [scenario, mode, expectedPass] of [['chat', 'ok', true], ['realtime', 'ok', true], ['chat', 'http-error', false], ['realtime', 'drop', false]]) {
  test(`Artillery ${scenario}/${mode}: integration and exit status`, { timeout: 120000 }, async t => {
    const fixture = await startFixture(mode);
    t.after(() => fixture.close());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bench-test-'));
    const envFile = path.join(root, 'fixture.env');
    fs.writeFileSync(envFile, `CHAT_API_URL=${fixture.target}\n`);
    const result = await runBenchmark({ scenario, profile: 'small', tasks: 1, seed: 42, envFile }, {
      users: fixture.users, resultsRoot: root, quiet: !process.env.BENCH_TEST_VERBOSE,
      phases: [{ name: 'Small baseline', duration: 1, arrivalCount: 4 }],
      timing: { delayMinMs: 1, delayMaxMs: 5, holdMs: 100, timeoutMs: 300, deadlineMs: 5000 },
    });
    assert.equal(result.summary.passed, expectedPass, JSON.stringify(result.summary.checks));
    assert.equal(result.exitCode, expectedPass ? 0 : 1);
    if (expectedPass) {
      assert.equal(result.summary.windows.whole.messagesSent, 20);
      assert.equal(result.summary.windows.whole.requestSuccesses, 32);
      if (scenario === 'realtime') {
        assert.equal(result.summary.windows.whole.recipientConfirmations, 20);
        assert.equal(result.summary.windows.whole.senderConfirmations, 20);
        assert.ok(result.summary.concurrency.peakSockets > 0);
      }
    }
    const persisted = fs.readFileSync(path.join(result.resultDir, 'summary.json'), 'utf8') + fs.readFileSync(path.join(result.resultDir, 'artillery.json'), 'utf8');
    assert.doesNotMatch(persisted, /fixture[0-3]/);
    assert.equal(fixture.connected(), 0);
    assert.ok(fs.existsSync(path.join(result.resultDir, 'summary.md')));
  });
}

test('Artillery multi-worker load fixture records phase windows and merged sockets', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bench-test-'));
  const envFile = path.join(root, 'fixture.env');
  fs.writeFileSync(envFile, `CHAT_API_URL=${fixture.target}\n`);
  const result = await runBenchmark({ scenario: 'realtime', profile: 'load', tasks: 3, seed: 42, envFile }, {
    users: fixture.users, resultsRoot: root, quiet: !process.env.BENCH_TEST_VERBOSE,
    phases: [{ name: 'Warm up', duration: 1, arrivalCount: 1 }, { name: 'Build', duration: 1, arrivalCount: 1 }, { name: 'Steady', duration: 2, arrivalRate: 2 }],
    timing: { delayMinMs: 1, delayMaxMs: 5, holdMs: 500, timeoutMs: 1000, deadlineMs: 5000 },
  });
  assert.equal(result.summary.passed, true, JSON.stringify(result.summary.checks));
  assert.equal(result.summary.windows.whole.messagesSent, 30);
  assert.equal(result.summary.windows.steady.durationSeconds, 2);
  assert.equal(result.summary.windows.settled.durationSeconds, 1.5);
  assert.ok(result.summary.observedWorkers >= 2);
  assert.ok(result.summary.concurrency.valid);
  assert.equal(fixture.connected(), 0);
});
