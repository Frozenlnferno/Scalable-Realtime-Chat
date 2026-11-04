const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { partition } = require('./pool.cjs');

async function poolController(_context, events) {
  const config = JSON.parse(fs.readFileSync(process.env.BENCH_RUNTIME_FILE, 'utf8'));
  return runController(config, events);
}
async function runController(config, events, dependencies = {}) {
  const WorkerClass = dependencies.Worker || Worker;
  const clock = dependencies.clock || { now: () => performance.now(), setTimeout, clearTimeout };
  const groups = partition(config.users, config.workers), workers = [];
  let timer, stage = 'boot', booted = 0, ready = 0, done = 0, finished = false;
  try {
    await new Promise((resolve, reject) => {
      const fail = () => {
        if (finished) return;
        finished = true;
        if (dependencies.onFailure) dependencies.onFailure(stage);
        else fs.writeFileSync(path.join(config.traceDir, 'controller.jsonl'), `${JSON.stringify({ type: 'setup_failure', stage, at: Date.now() })}\n`);
        reject(new Error('pool_controller_failed'));
      };
      const deadline = ms => { clock.clearTimeout(timer); timer = clock.setTimeout(fail, ms); };
      deadline(30000);
      for (const [workerIndex, indices] of groups.entries()) {
        const worker = new WorkerClass(path.join(__dirname, 'pool-worker.cjs'), { workerData: { config, indices, workerIndex } });
        workers.push(worker);
        worker.on('error', fail);
        worker.on('exit', code => { if (code !== 0 || (!finished && done < groups.length && stage === 'boot')) fail(); });
        worker.on('message', message => {
          if (finished) return;
          if (message.metric) { events.emit(message.metric, message.name, message.value); return; }
          if (message.type === 'booted' && ++booted === groups.length) {
            stage = 'ramp';
            const at = clock.now() + 100;
            for (const w of workers) w.postMessage({ type: 'ramp', at });
            deadline(100 + config.timing.rampMs + config.timing.graceMs);
          }
          if (message.type === 'ready' && ++ready === groups.length) {
            stage = 'measure';
            const at = clock.now() + 100;
            for (const w of workers) w.postMessage({ type: 'start', at });
            deadline(100 + config.timing.measureMs + config.timing.drainMs + 5000);
          }
          if (message.type === 'done') {
            done++;
            if (stage !== 'measure') { fail(); return; }
            if (done === groups.length) { finished = true; clock.clearTimeout(timer); resolve(); }
          }
        });
      }
    });
  } finally {
    clock.clearTimeout(timer);
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}
module.exports = { poolController, runController };
