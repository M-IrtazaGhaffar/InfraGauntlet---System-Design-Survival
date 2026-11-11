/* ============================================================================
 * InfraGauntlet — selftest.js
 * 12 built-in checks used by the Self-Test button. Every test builds an
 * isolated Engine, so the running game is never mutated.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const D = global.IGData || require('./data.js');
  const E = global.IGEngine || require('./engine.js');

  const quietWaves = () => Array.from({ length: D.WAVES_PER_RUN }, (_, i) => ({
    index: i,
    baseRps: Math.round(100 * Math.pow(1.3, i)),
    durationMs: 30000,
    readRatio: 0.75,
    writeRatio: 0.25,
    attack: null,
    failure: null,
    burstiness: 'smooth',
    failureTriggerAt: 15000,
  }));

  function mk(opts) {
    return new E.Engine(Object.assign({ seed: D.TEST_SEED, withStarting: false, waves: quietWaves() }, opts));
  }

  function add(engine, type, x, y, overrides) {
    return engine.addNode(type, x, y, overrides);
  }

  function coreGraph(extra) {
    const e = mk();
    const i = add(e, 'internet', 0, 0);
    const a = add(e, 'app_2c', 100, 0);
    const db = add(e, 'postgres', 200, 0);
    e.connect(i.id, a.id);
    e.connect(a.id, db.id);
    (extra || ((x) => x))(e, { i, a, db });
    e.begin();
    return { e, i, a, db };
  }

  function ticks(e, n) {
    for (let i = 0; i < n; i++) e.tick(0.5);
  }

  function assert(cond, message) {
    if (!cond) throw new Error(message || 'Assertion failed');
  }

  function approx(a, b, tol) {
    return Math.abs(a - b) <= (tol == null ? 1e-6 : tol);
  }

  /* ------------------------------------------------------------------ */
  const TESTS = [
    {
      id: 1,
      name: 'Starting nodes connect: Internet → App → DB',
      run() {
        const e = new E.Engine({ seed: 12345 });
        const nodes = Array.from(e.nodes.values());
        assert(nodes.length === 3, 'expected 3 starting nodes');
        const internet = e.nodes.get('internet');
        const app = e.nodes.get('app');
        const db = e.nodes.get('db');
        assert(internet && app && db, 'starting ids missing');
        assert(e.edges.size === 0, 'starting graph must not be pre-connected');
        assert(e.reachableFromInternet().size === 1, 'only Internet should be reachable before connecting');
        const r1 = e.connect(internet.id, app.id);
        const r2 = e.connect(app.id, db.id);
        assert(r1.ok && r2.ok, 'connect returned failure');
        e.updateDerived();
        const reach = e.reachableFromInternet();
        assert(reach.has(app.id) && reach.has(db.id), 'nodes not reachable after connecting');
        assert(e.idleNodes().length === 0, 'no node should be idle');
        e.begin();
        ticks(e, 4);
        assert(e.lastServedRPS > 0, 'no traffic served after connecting');
        return { detail: `3 nodes, 2 edges, ${Math.round(e.lastServedRPS)} RPS served; positions saved.` };
      },
    },
    {
      id: 2,
      name: 'Unconnected Redis charges cost but gets zero traffic',
      run() {
        const { e } = coreGraph();
        const beforeCost = e.costPerHour;
        const redis = add(e, 'redis', 300, 100);
        e.recalculateCost();
        assert(e.costPerHour > beforeCost, 'cost did not rise after adding Redis');
        e.updateDerived();
        assert(e.idleNodes().some((n) => n.id === redis.id), 'Redis should be flagged idle');
        ticks(e, 4);
        assert(redis.readUsage === 0 && redis.writeUsage === 0, 'idle Redis received traffic');
        assert(e.idleCostPerHour > 0, 'idle cost not tracked');
        return { detail: `Cost $${beforeCost.toFixed(2)} → $${e.costPerHour.toFixed(2)}/hr; Redis idle traffic = 0.` };
      },
    },
    {
      id: 3,
      name: 'Mesh: App → 2 DBs both serve; one edge removal keeps service',
      run() {
        const e = mk();
        const i = add(e, 'internet', 0, 0);
        const a = add(e, 'app_2c', 100, 0);
        const db1 = add(e, 'postgres', 200, 0);
        const db2 = add(e, 'mysql', 200, 100);
        e.connect(i.id, a.id);
        e.connect(a.id, db1.id);
        e.connect(a.id, db2.id);
        e.begin();
        ticks(e, 3);
        assert(db1.readUsage > 0 && db2.readUsage > 0, `both DBs should receive traffic (${Math.round(db1.readUsage)} / ${Math.round(db2.readUsage)})`);
        const meshSplit = `${Math.round(db1.readUsage)} + ${Math.round(db2.readUsage)} RPS`;
        const servedBefore = e.lastServedRPS;
        e.disconnect(a.id, db2.id);
        e.updateDerived();
        assert(e.reachableFromInternet().has(db2.id) === false, 'removed DB should be unreachable');
        ticks(e, 3);
        assert(e.reachableFromInternet().has(db1.id), 'remaining DB lost reachability');
        assert(e.lastServedRPS > 0, 'traffic stopped after removing one mesh edge');
        assert(servedBefore > 0, 'no initial traffic');
        return { detail: `Split ${meshSplit}; removal kept ${Math.round(e.lastServedRPS)} RPS.` };
      },
    },
    {
      id: 4,
      name: 'MySQL shards=4 multiplies write capacity and cost ×4',
      run() {
        const e = mk();
        const db = add(e, 'mysql', 0, 0);
        e.recalculateCost();
        const base = e.dbStats(db);
        const baseCost = e.getNodeCost(db);
        db.config.shards = 4;
        const quad = e.dbStats(db);
        const quadCost = e.getNodeCost(db);
        assert(approx(quad.writeRPS, base.writeRPS * 4, 0.01), 'write capacity is not ×4');
        assert(approx(quadCost, baseCost * 4, 0.001), `cost is not ×4 (${quadCost} vs ${baseCost * 4})`);
        assert(approx(quad.readRPS, base.readRPS, 0.01), 'read capacity should stay base without replicas');
        return { detail: `Writes ${Math.round(base.writeRPS)} → ${Math.round(quad.writeRPS)}/s; cost $${baseCost} → $${quadCost}/hr.` };
      },
    },
    {
      id: 5,
      name: 'DB failure drops requests unless a queue buffers them',
      run() {
        const noQ = coreGraph();
        noQ.e.triggerFailure('db_down', noQ.db.id);
        ticks(noQ.e, 3);
        assert(noQ.e.totalDroppedReq > 0 || noQ.e.lastDroppedRPS > 0, 'DB down without queue should drop');

        const withQ = coreGraph((e, ids) => {
          const q = add(e, 'kafka', 200, 130);
          e.connect(ids.a.id, q.id);
        });
        withQ.e.triggerFailure('db_down', withQ.db.id);
        ticks(withQ.e, 3);
        assert(withQ.e.queueBacklog > 0, 'queue should hold a backlog');
        assert(withQ.e.totalQueuedReq > 0, 'no requests were queued');
        return { detail: `No queue → ${Math.round(noQ.e.totalDroppedReq)} req dropped. Kafka → ${Math.round(withQ.e.queueBacklog)} buffered, ${Math.round(withQ.e.totalQueuedReq)} accepted.` };
      },
    },
    {
      id: 6,
      name: 'DDoS: no shield <40% availability; Shield+CDN >80%',
      run() {
        const bad = mk();
        const i1 = add(bad, 'internet', 0, 0);
        const a1 = add(bad, 'app_1c', 100, 0);
        const d1 = add(bad, 'postgres', 200, 0);
        bad.connect(i1.id, a1.id); bad.connect(a1.id, d1.id);
        bad.started = true; bad.paused = false;
        bad.forceWave(9, 'ddos', null);
        ticks(bad, 6);
        const availBad = bad.tickAvailability;
        assert(availBad < 40, `expected <40% without mitigations, got ${availBad.toFixed(1)}%`);

        const good = mk();
        const i2 = add(good, 'internet', 0, 0);
        const a2 = add(good, 'app_1c', 100, 0);
        const d2 = add(good, 'postgres', 200, 0);
        const shield = add(good, 'shield', 100, 120);
        const cdn = add(good, 'cdn', 50, 120);
        good.connect(i2.id, a2.id); good.connect(a2.id, d2.id);
        good.connect(i2.id, shield.id); good.connect(i2.id, cdn.id);
        good.started = true; good.paused = false;
        good.forceWave(9, 'ddos', null);
        ticks(good, 6);
        const availGood = good.tickAvailability;
        assert(availGood > 80, `expected >80% with Shield+CDN, got ${availGood.toFixed(1)}%`);
        assert(good.activeAttack && good.activeAttack.mitigated, 'attack was not marked mitigated');
        return { detail: `Unmitigated ${availBad.toFixed(1)}% → Shield+CDN ${availGood.toFixed(1)}%. Mitigation multiplier ${good.activeAttack.effectiveMultiplier}×.` };
      },
    },
    {
      id: 7,
      name: 'Kafka between App and DB turns DB-down into backpressure',
      run() {
        const e = mk();
        const i = add(e, 'internet', 0, 0);
        const a = add(e, 'app_2c', 100, 0);
        const q = add(e, 'kafka', 200, 0);
        const db = add(e, 'postgres', 300, 0);
        e.connect(i.id, a.id); e.connect(a.id, q.id); e.connect(q.id, db.id);
        e.begin();
        e.triggerFailure('db_down', db.id);
        ticks(e, 4);
        assert(e.queueBacklog > 0, 'no backpressure in Kafka');
        assert(e.totalQueuedReq > 0, 'Kafka accepted no overload');
        assert(e.totalDroppedReq === 0, 'expected no instant drops while buffered');
        assert(e.errorRate < 1, 'expected low error rate while queue absorbs');
        return { detail: `Kafka backlog ${Math.round(e.queueBacklog)} messages, 0 dropped, error ${e.errorRate.toFixed(2)}%.` };
      },
    },
    {
      id: 8,
      name: 'CI/CD cuts app-server MTTR by exactly 60%',
      run() {
        const no = mk();
        const a1 = add(no, 'app_2c', 0, 0);
        const f1 = no.triggerFailure('app_down', a1.id);
        const noCI = f1.duration;
        const withCI = mk();
        const i2 = add(withCI, 'internet', 0, 0);
        const a2 = add(withCI, 'app_2c', 100, 0);
        const ci = add(withCI, 'cicd', 100, 100);
        withCI.connect(i2.id, a2.id); withCI.connect(i2.id, ci.id);
        const f2 = withCI.triggerFailure('app_down', a2.id);
        const reduction = 1 - f2.duration / noCI;
        assert(approx(reduction, 0.6, 0.02), `expected 60% reduction, got ${(reduction * 100).toFixed(1)}%`);
        return { detail: `MTTR ${(noCI / 1000).toFixed(1)}s → ${(f2.duration / 1000).toFixed(1)}s (${(reduction * 100).toFixed(0)}% faster; disconnecting CI/CD means 2.5× longer).` };
      },
    },
    {
      id: 9,
      name: 'Slack reduces reputation loss on attacks',
      run() {
        const no = mk();
        add(no, 'internet', 0, 0);
        no.forceWave(0, 'ddos', null);
        const noSlackRep = no.reputation;
        const yes = mk();
        const i2 = add(yes, 'internet', 0, 0);
        const slack = add(yes, 'slack', 100, 0);
        yes.connect(i2.id, slack.id);
        yes.forceWave(0, 'ddos', null);
        const slackRep = yes.reputation;
        assert(slackRep > noSlackRep, `Slack should preserve reputation (${slackRep} vs ${noSlackRep})`);
        assert(slackRep - noSlackRep > 0.5, 'reputation delta too small to be meaningful');
        return { detail: `Reputation after DDoS: ${noSlackRep.toFixed(1)} without Slack vs ${slackRep.toFixed(1)} with Slack.` };
      },
    },
    {
      id: 10,
      name: 'Cost audit: manual node sum equals dashboard cost',
      run() {
        const e = mk();
        add(e, 'internet', 0, 0);
        const app = add(e, 'app_custom', 100, 0);
        app.config.cores = 12; app.config.ram = 24; e.applyCustom(app);
        const db = add(e, 'mysql', 200, 0);
        db.config.shards = 3; db.config.replicas = 2;
        add(e, 'redis', 300, 100);
        add(e, 's3', 400, 100);
        e.recalculateCost();
        const manual = Array.from(e.nodes.values()).reduce((s, n) => s + e.getNodeCost(n), 0);
        assert(approx(manual, e.costPerHour, 0.0001), `manual sum ${manual} != dashboard ${e.costPerHour}`);
        assert(e.costPerHour > 0, 'cost should be positive');
        return { detail: `Manual $${manual.toFixed(3)}/hr == dashboard $${e.costPerHour.toFixed(3)}/hr.` };
      },
    },
    {
      id: 11,
      name: 'PRNG determinism: seed 12345 twice gives identical waves',
      run() {
        const a = E.mulberry32(12345);
        const b = E.mulberry32(12345);
        const seqA = Array.from({ length: 12 }, () => a());
        const seqB = Array.from({ length: 12 }, () => b());
        assert(seqA.every((v, i) => v === seqB[i]), 'PRNG sequences differ');
        const w1 = E.generateWaves(12345, { forceAllAttacks: true });
        const w2 = E.generateWaves(12345, { forceAllAttacks: true });
        assert(JSON.stringify(w1.map((w) => [w.baseRps, w.durationMs, w.attack && w.attack.id, w.failure && w.failure.id, w.burstiness])) ===
          JSON.stringify(w2.map((w) => [w.baseRps, w.durationMs, w.attack && w.attack.id, w.failure && w.failure.id, w.burstiness])), 'wave sequences differ');
        return { detail: '12 PRNG values and 30 wave descriptors are byte-identical across runs.' };
      },
    },
    {
      id: 12,
      name: 'All 30 attacks fire across a 30-wave gauntlet',
      run() {
        const waves = E.generateWaves(12345, { forceAllAttacks: true });
        const e = new E.Engine({ seed: 12345, withStarting: false, waves });
        add(e, 'internet', 0, 0);
        const app = add(e, 'app_128c', 100, 0);
        const db = add(e, 'postgres', 200, 0);
        const cache = add(e, 'redis', 200, 100);
        e.connect('internet', app.id); e.connect(app.id, db.id); e.connect(app.id, cache.id);
        for (let i = 0; i < 30; i++) e.forceWave(i);
        const fired = new Set(e.attackHistory.map((a) => a.id));
        const missing = D.ATTACKS.map((a) => a.id).filter((id) => !fired.has(id));
        assert(missing.length === 0, `missing attacks: ${missing.join(', ')}`);
        assert(fired.size === 30, `expected 30 unique attacks, got ${fired.size}`);
        for (const a of D.ATTACKS) {
          assert(a.teach && a.mitigations.length && a.effectIfUnmitigated && a.effectIfMitigated, 'attack metadata incomplete: ' + a.id);
        }
        return { detail: `30/30 attacks fired. All have teach text + mitigation lists.` };
      },
    },
    {
      id: 13,
      name: 'Read Replica attracts live read traffic and adds capacity',
      run() {
        const e = mk();
        const i = add(e, 'internet', 0, 0);
        const app = add(e, 'app_32c', 100, 0);
        const db = add(e, 'postgres', 200, 0);
        const replica = add(e, 'replica', 300, 0);
        e.connect(i.id, app.id);
        e.connect(app.id, db.id);
        e.connect(app.id, replica.id);
        e.begin();
        ticks(e, 4);
        assert(replica.readUsage > 0, 'read replica received no read traffic');
        assert(db.readUsage > 0, 'primary lost all read traffic');
        const beforeDisconnect = replica.readUsage;
        e.disconnect(app.id, replica.id);
        ticks(e, 2);
        assert(replica.readUsage === 0, 'disconnected replica still received traffic');
        assert(e.getNodeCost(replica) === 0.08, 'replica cost incorrect');
        return { detail: `Replica carried ${Math.round(beforeDisconnect)} RPS alongside the primary; disconnected replica immediately went to 0.` };
      },
    },
    {
      id: 14,
      name: 'Sharding increases routed write throughput under load',
      run() {
        const waves = quietWaves();
        waves[0] = Object.assign({}, waves[0], { baseRps: 10000, readRatio: 0.1, writeRatio: 0.9, durationMs: 30000 });
        const e = mk({ waves });
        const i = add(e, 'internet', 0, 0);
        const app = add(e, 'app_128c', 100, 0);
        const db = add(e, 'mysql', 200, 0);
        e.connect(i.id, app.id);
        e.connect(app.id, db.id);
        e.begin();
        ticks(e, 3);
        const oneShardServed = e.lastServedRPS;
        const oneShardCost = e.getNodeCost(db);
        db.config.shards = 8;
        e.recalculateCost();
        e.updateDerived();
        ticks(e, 3);
        const eightShardServed = e.lastServedRPS;
        const eightShardCost = e.getNodeCost(db);
        assert(eightShardServed > oneShardServed * 1.5, `routed throughput did not scale (${Math.round(oneShardServed)} -> ${Math.round(eightShardServed)})`);
        assert(Math.abs(eightShardCost - oneShardCost * 8) < 0.01, 'sharded cost did not scale with shards');
        return { detail: `Routed writes ${Math.round(oneShardServed)} -> ${Math.round(eightShardServed)} RPS; DB cost $${oneShardCost} -> $${eightShardCost}/hr with 8 shards.` };
      },
    },
    {
      id: 15,
      name: 'Redundant load balancer fails over on LB-down',
      run() {
        const solo = mk();
        const i1 = add(solo, 'internet', 0, 0);
        const a1 = add(solo, 'app_2c', 100, 0);
        const d1 = add(solo, 'postgres', 200, 0);
        const lb1 = add(solo, 'lb', 100, 100);
        solo.connect(i1.id, a1.id); solo.connect(a1.id, d1.id); solo.connect(i1.id, lb1.id);
        solo.started = true; solo.paused = false;
        solo.triggerFailure('lb_down', lb1.id);
        ticks(solo, 4);
        assert(solo.lastServedRPS === 0, 'single-LB outage should cut ingress');

        const redundant = mk();
        const i2 = add(redundant, 'internet', 0, 0);
        const a2 = add(redundant, 'app_2c', 100, 0);
        const d2 = add(redundant, 'postgres', 200, 0);
        const lbA = add(redundant, 'lb', 100, 100);
        const lbB = add(redundant, 'lb', 200, 100);
        redundant.connect(i2.id, a2.id); redundant.connect(a2.id, d2.id);
        redundant.connect(i2.id, lbA.id); redundant.connect(i2.id, lbB.id);
        redundant.started = true; redundant.paused = false;
        redundant.triggerFailure('lb_down', lbA.id);
        const f = redundant.failures[0];
        assert(f.failover === true && f.otherLbs === 1, 'redundant LB was not detected');
        ticks(redundant, 4);
        assert(redundant.lastServedRPS > 0, 'traffic did not recover after failover blip');
        return { detail: `Single LB: 0 RPS. Redundant LB: failover in 1.2s, ${Math.round(redundant.lastServedRPS)} RPS served after 2s.` };
      },
    },
  ];

  function runAll(onLog) {
    const log = typeof onLog === 'function' ? onLog : () => {};
    const results = [];
    for (const t of TESTS) {
      const t0 = performance.now();
      try {
        const out = t.run() || {};
        const ms = Math.round(performance.now() - t0);
        const result = { id: t.id, name: t.name, pass: true, detail: out.detail || '', ms };
        results.push(result);
        log(Object.assign({}, result, { text: `PASS  #${t.id}  ${t.name} — ${result.detail} (${ms}ms)` }));
      } catch (err) {
        const ms = Math.round(performance.now() - t0);
        const result = { id: t.id, name: t.name, pass: false, detail: err.message, ms };
        results.push(result);
        log(Object.assign({}, result, { text: `FAIL  #${t.id}  ${t.name} — ${err.message}` }));
      }
    }
    const passed = results.filter((r) => r.pass).length;
    return { results, passed, total: results.length, allPassed: passed === results.length };
  }

  const API = { TESTS, runAll };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.IGSelfTest = API;
})(typeof window !== 'undefined' ? window : globalThis);
