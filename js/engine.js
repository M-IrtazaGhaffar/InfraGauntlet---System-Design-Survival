/* ============================================================================
 * InfraGauntlet — engine.js
 * Pure simulation engine: seeded waves, graph routing, capacity, attacks,
 * failures, mitigation checks, costs and game-over conditions.
 *
 * Design notes
 * ------------
 * - The engine is DOM-free and deterministic for a given seed. UI can be
 *   swapped or driven by the self-test harness.
 * - Traffic is routed by enumerating simple paths from Internet to handler
 *   nodes (DB / cache / S3). Multiple paths are allocated in two passes so a
 *   mesh gives traffic to more than one database. Node capacities are shared
 *   across paths: allocations are scaled per node so no node is over-driven.
 * - Overflow is buffered by healthy queues (Kafka / RabbitMQ). Accepted queue
 *   messages count as accepted (high latency, backlog grows) rather than
 *   dropped, which is what gives DB-down waves backpressure instead of an
 *   instant error cliff.
 * - Every node charges cost every tick, connected or not.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const D = global.IGData;
  if (!D) throw new Error('data.js must load before engine.js');

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const round = (n, p) => {
    const f = Math.pow(10, p == null ? 2 : p);
    return Math.round(n * f) / f;
  };
  const uid = (() => {
    let n = 0;
    return (p) => `${p}_${Date.now().toString(36)}_${(++n).toString(36)}`;
  })();

  /** mulberry32 — tiny seeded PRNG. Same seed => same sequence. */
  function mulberry32(a) {
    let seed = a >>> 0;
    return function () {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(input) {
    const s = String(input == null ? '' : input);
    if (/^\d+$/.test(s)) return (parseInt(s, 10) >>> 0) || 1;
    let h = 2166136261 ^ 0x9e3779b9;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function shuffled(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Generate a finite sequence of 30 waves. */
  function generateWaves(seed, opts) {
    opts = opts || {};
    const rng = mulberry32(hashSeed(seed));
    const attackDeck = shuffled(D.ATTACKS.map((a) => a.id), rng);
    const failDeck = shuffled(D.FAILURES.map((f) => f.id), rng);
    const burst = ['smooth', 'spiky', 'step', 'sine'];
    const waves = [];
    let deckPtr = 0;
    let failPtr = 0;
    for (let i = 0; i < D.WAVES_PER_RUN; i++) {
      const durationMs = 15000 + Math.round((rng() * 15000) / 500) * 500;
      const readRatio = round(0.6 + rng() * 0.3, 3);
      let attack = null;
      if (opts.forceAllAttacks) {
        attack = D.ATTACKS[i % D.ATTACKS.length];
      } else if (rng() < 0.7) {
        // 70% of waves have an attack => ~30% quiet waves, as specified.
        attack = D.ATTACK_BY_ID[attackDeck[deckPtr % attackDeck.length]];
        deckPtr++;
      }
      let failure = null;
      if (opts.forceAllFailures) {
        failure = D.FAILURES[i % D.FAILURES.length];
      } else if (rng() < 0.2) {
        failure = D.FAILURE_BY_ID[failDeck[failPtr % failDeck.length]];
        failPtr++;
      }
      waves.push({
        index: i,
        baseRps: Math.round(D.BASE_RPS * Math.pow(D.WAVE_GROWTH, i)),
        durationMs,
        readRatio,
        writeRatio: round(1 - readRatio, 3),
        attack,
        failure,
        burstiness: burst[Math.floor(rng() * burst.length)],
        failureTriggerAt: Math.round(durationMs * (0.25 + rng() * 0.45)),
      });
    }
    return waves;
  }

  class Engine {
    constructor(options) {
      options = options || {};
      this.seedInput = options.seed == null ? D.TEST_SEED : options.seed;
      this.rng = mulberry32(hashSeed(this.seedInput));
      this.nodes = new Map();
      this.edges = new Map();
      this.nextId = 1;
      this.edgeCounter = 0;
      this.events = [];
      this.failures = [];
      this.attackHistory = [];
      this.lastScorecard = null;
      this.reset(options);
    }

    /* ------------------------------------------------------------------ */
    /* LIFECYCLE                                                           */
    /* ------------------------------------------------------------------ */
    reset(options) {
      options = options || {};
      const keepSeed = options.seed == null ? this.seedInput : options.seed;
      this.seedInput = keepSeed;
      this.seed = hashSeed(keepSeed);
      this.rng = mulberry32(this.seed);
      this.nodes = new Map();
      this.edges = new Map();
      this.nextId = 1;
      this.edgeCounter = 0;
      this.events = [];
      this.failures = [];
      this.attackHistory = [];
      this.lastScorecard = null;

      this.started = false;
      this.paused = true;
      this.gameOver = false;
      this.victory = false;
      this.gameOverReason = '';
      this.simTime = 0; // milliseconds of simulated time
      this.waveIndex = 0;
      this.waveElapsed = 0;
      this.waveNumber = 1;
      this.waves = options.waves || generateWaves(this.seed, options.waveOptions || {});

      this.reputation = 100;
      this.budgetPerHour = options.budget != null ? options.budget : D.START_BUDGET;
      this.costSpent = 0;
      this.costPerHour = 0;
      this.totalDemandReq = 0;
      this.totalServedReq = 0;
      this.totalDroppedReq = 0;
      this.totalErrorReq = 0;
      this.totalQueuedReq = 0;
      this.totalRevenue = 0;
      this.peakServedRPS = 0;
      this.availability = 100;
      this.tickAvailability = 100;
      this.latencyMs = 0;
      this.p99Ms = 0;
      this.errorRate = 0;
      this.utilization = 0;
      this.lastDemandRPS = 0;
      this.lastServedRPS = 0;
      this.lastDroppedRPS = 0;
      this.lastQueuedRPS = 0;
      this.lowAvailMs = 0;
      this.overBudgetMs = 0;
      this.attacksMitigated = 0;
      this.attacksMissed = 0;
      this.failuresSeen = 0;
      this.queueBacklog = 0;
      this.activeAttack = null;
      this.activeFailure = null;
      this.attackTargetId = null;
      this.mitigationNodeIds = [];
      this._attackErrorRate = 0;
      this._attackMultiplier = 1;
      this._attackMaliciousRatio = 0;
      this._attackMitigated = false;
      this.globalOutageUntil = 0;
      this.partitionUntil = 0;
      this.waveFlash = false;
      this._flashUntil = 0;
      this.lastTickAt = 0;
      this.warnings = [];
      this.metrics = {};
      this.topologyLabel = 'Disconnected';

      if (options.withStarting !== false) this.createStartingNodes();
      if (options.nodes && options.nodes.length) {
        options.nodes.forEach((n) => this.addNode(n.type, n.x, n.y, n));
      }
      if (options.edges && options.edges.length) {
        options.edges.forEach((e) => this.connect(e.from, e.to));
      }
      this.recalculateCost();
      this.updateDerived();
      return this;
    }

    createStartingNodes() {
      const c = (type, x, y, id, label) => {
        const n = this.addNode(type, x, y, { id });
        if (label) n.label = label;
        return n;
      };
      c('internet', 120, 210, 'internet', 'Internet');
      c('app_2c', 420, 210, 'app', 'App Server 2c/2GB');
      c('postgres', 720, 210, 'db', 'Database (PostgreSQL)');
    }

    begin() {
      if (this.started) return false;
      this.started = true;
      this.paused = false;
      this.enterWave(0);
      this.pushEvent({ kind: 'system', tone: 'info', icon: 'play', message: 'Run started — connect Internet → App → DB before capacity runs out.' });
      return true;
    }

    pause() {
      this.paused = true;
    }

    resume() {
      if (this.started && !this.gameOver && !this.victory) {
        this.paused = false;
        return true;
      }
      return false;
    }

    /* ------------------------------------------------------------------ */
    /* GRAPH API                                                           */
    /* ------------------------------------------------------------------ */
    addNode(type, x, y, overrides) {
      const base = D.COMPONENT_BY_TYPE[type];
      if (!base) throw new Error('Unknown node type ' + type);
      overrides = overrides || {};
      if (type === 'internet') {
        for (const n of this.nodes.values()) if (n.type === 'internet') return n;
        if (!overrides.id) overrides.id = 'internet';
      }
      const id = overrides.id || `${type}_${this.nextId++}`;
      if (this.nodes.has(id)) throw new Error('Duplicate node id ' + id);
      const node = {
        id,
        type,
        label: overrides.label || base.label,
        category: base.category,
        icon: base.icon,
        color: base.color,
        costPerHour: base.costPerHour,
        baseCapacityRPS: base.baseCapacityRPS,
        baseReadRPS: base.baseReadRPS || 0,
        baseWriteRPS: base.baseWriteRPS || 0,
        latencyMs: base.latencyMs,
        health: base.health,
        config: Object.assign({}, base.config, overrides.config || {}),
        custom: !!base.custom,
        source: !!base.source,
        description: base.description,
        failureMode: base.failureMode,
        x: x == null ? 300 : x,
        y: y == null ? 180 : y,
        downUntil: 0,
        failure: null,
        healthBar: 1,
        load: 0,
        readUsage: 0,
        writeUsage: 0,
        currentCost: base.costPerHour,
        totalServed: 0,
        staticOffload: base.staticOffload || 0,
        bufferRPS: base.bufferRPS || 0,
        maxBacklogSeconds: base.maxBacklogSeconds || 0,
        backlog: 0,
        attachedTo: overrides.attachedTo || null,
      };
      if (overrides.config) Object.assign(node.config, overrides.config);
      if (node.custom) this.applyCustom(node);
      this.nodes.set(id, node);
      this.nextId++;
      this.recalculateCost();
      this.updateDerived();
      return node;
    }

    removeNode(id) {
      const node = this.nodes.get(id);
      if (!node) return false;
      if (node.type === 'internet') return false;
      for (const [key, edge] of Array.from(this.edges.entries())) {
        if (edge.from === id || edge.to === id) this.edges.delete(key);
      }
      this.nodes.delete(id);
      this.recalculateCost();
      this.updateDerived();
      this.pushEvent({ kind: 'system', tone: 'warn', icon: 'trash-2', message: `${node.label} taken down — its $${round(node.currentCost, 2)}/hr is no longer charged.` });
      return true;
    }

    connect(fromId, toId) {
      if (fromId === toId) return { ok: false, reason: 'A node cannot connect to itself.' };
      if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return { ok: false, reason: 'Missing node.' };
      const key = `${fromId}|${toId}`;
      if (this.edges.has(key)) return { ok: false, reason: 'Connection already exists.' };
      // Avoid duplicate reverse edge: it makes traffic loops / visual noise.
      if (this.edges.has(`${toId}|${fromId}`)) return { ok: false, reason: 'Reverse connection already exists.' };
      const edge = { id: `e${++this.edgeCounter}`, from: fromId, to: toId, flow: 0, active: true, key };
      this.edges.set(key, edge);
      this.updateDerived();
      return { ok: true, edge };
    }

    disconnect(fromOrKey, toId) {
      let key = fromOrKey;
      if (toId != null) key = `${fromOrKey}|${toId}`;
      if (!this.edges.has(key)) return false;
      this.edges.delete(key);
      this.updateDerived();
      return true;
    }

    getEdge(from, to) {
      return this.edges.get(`${from}|${to}`) || null;
    }

    edgesFor(nodeId) {
      return Array.from(this.edges.values()).filter((e) => e.from === nodeId || e.to === nodeId);
    }

    clearGraph() {
      for (const n of Array.from(this.nodes.values())) if (n.type !== 'internet') this.nodes.delete(n.id);
      this.edges.clear();
      this.recalculateCost();
      this.updateDerived();
    }

    /** Reachable from Internet through directed edges (health ignored). */
    reachableFromInternet() {
      const seen = new Set();
      if (!this.nodes.has('internet')) return seen;
      const q = ['internet'];
      seen.add('internet');
      while (q.length) {
        const id = q.shift();
        for (const e of this.edges.values()) {
          if (e.from === id && !seen.has(e.to)) {
            seen.add(e.to);
            q.push(e.to);
          }
        }
      }
      return seen;
    }

    idleNodes() {
      const reach = this.reachableFromInternet();
      return Array.from(this.nodes.values()).filter((n) => !reach.has(n.id));
    }

    /** Adjacency map: id -> [{edge, to}] */
    adjacency(healthyOnly) {
      const adj = new Map();
      for (const n of this.nodes.values()) adj.set(n.id, []);
      for (const e of this.edges.values()) {
        if (healthyOnly && this.isNodeDown(this.nodes.get(e.from)) ) continue;
        if (healthyOnly && this.isNodeDown(this.nodes.get(e.to))) continue;
        const list = adj.get(e.from);
        if (list) list.push({ edge: e, to: e.to });
      }
      return adj;
    }

    topology() {
      const nodes = Array.from(this.nodes.values());
      const n = nodes.length;
      const deg = new Map(nodes.map((x) => [x.id, 0]));
      let unique = 0;
      const seen = new Set();
      for (const e of this.edges.values()) {
        const u = [e.from, e.to].sort().join('|');
        if (seen.has(u)) continue;
        seen.add(u);
        unique++;
        deg.set(e.from, (deg.get(e.from) || 0) + 1);
        deg.set(e.to, (deg.get(e.to) || 0) + 1);
      }
      if (unique === 0) return 'Disconnected';
      const reach = this.reachableFromInternet();
      const active = nodes.filter((x) => reach.has(x.id));
      if (active.length < n) return 'Hybrid';
      const degrees = Array.from(deg.values());
      const maxDeg = Math.max(...degrees);
      const leafCount = degrees.filter((d) => d === 1).length;
      if (unique === n - 1 && maxDeg === n - 1 && leafCount === n - 1) return 'Star';
      if (unique === n && degrees.every((d) => d === 2)) return 'Ring';
      const density = (2 * unique) / (n * (n - 1));
      if (density >= 0.45) return 'Mesh';
      return 'Hybrid';
    }

    updateDerived() {
      this.topologyLabel = this.topology();
      const reach = this.reachableFromInternet();
      this.idleNodeIds = Array.from(this.nodes.values()).filter((x) => !reach.has(x.id)).map((x) => x.id);
      this.idleCostPerHour = this.idleNodeIds.reduce((s, id) => s + (this.nodes.get(id) ? this.getNodeCost(this.nodes.get(id)) : 0), 0);
      this.rawCostPerHour = Array.from(this.nodes.values()).reduce((s, n) => s + this.getNodeCost(n), 0);
      this.recalculateCost();
    }

    /* ------------------------------------------------------------------ */
    /* NODE MATH                                                           */
    /* ------------------------------------------------------------------ */
    dbStats(node) {
      const shards = clamp(Number(node.config.shards) || 1, 1, 16);
      const replicas = clamp(Number(node.config.replicas) || 0, 0, 5);
      return {
        shards,
        replicas,
        readRPS: (node.baseReadRPS || node.baseCapacityRPS) * (1 + replicas),
        writeRPS: (node.baseWriteRPS || 0) * shards,
        costPerHour: node.costPerHour * shards * (1 + replicas * 0.6),
        replicationLag: replicas > 3,
      };
    }

    applyCustom(node) {
      const cores = clamp(parseInt(node.config.cores, 10) || 1, 1, 128);
      const ram = clamp(parseInt(node.config.ram, 10) || 1, 1, 512);
      node.config.cores = cores;
      node.config.ram = ram;
      node.baseCapacityRPS = cores * 1500;
      node.costPerHour = round(cores * 0.02 + ram * 0.005, 3);
    }

    getNodeCost(node) {
      if (node.category === 'database' && node.baseWriteRPS > 0) return round(this.dbStats(node).costPerHour, 4);
      if (node.custom) return round((node.config.cores || 1) * 0.02 + (node.config.ram || 1) * 0.005, 4);
      return round(node.costPerHour, 4);
    }

    recalcularCost() { this.recalculateCost(); }
    recalculateCost() {
      let sum = 0;
      for (const n of this.nodes.values()) {
        n.currentCost = this.getNodeCost(n);
        sum += n.currentCost;
      }
      this.costPerHour = round(sum, 4);
      return this.costPerHour;
    }

    nodeCapacity(node, mode) {
      if (!node || this.isNodeDown(node)) return 0;
      if (node.type === 'internet') return Infinity;
      if (node.category === 'database') {
        const s = this.dbStats(node);
        return mode === 'write' ? s.writeRPS : s.readRPS;
      }
      if (mode === 'write') {
        if (node.category === 'cache') return 0; // cache is read-only as a handler
        if (node.type === 's3') return node.baseWriteRPS || 0;
        return node.baseCapacityRPS || 0;
      }
      return node.baseCapacityRPS || 0;
    }

    isNodeDown(node) {
      return !node || (node.downUntil && node.downUntil > this.simTime);
    }

    nodeStatus(node) {
      if (!node) return 'unknown';
      if (this.isNodeDown(node)) return 'down';
      if (node.load > 0.95) return 'saturated';
      if (node.load > 0.7) return 'hot';
      if (this.idleNodeIds && this.idleNodeIds.includes(node.id)) return 'idle';
      return 'healthy';
    }

    /** Does the graph contain a healthy, Internet-reachable node matching token? */
    has(token) {
      const reach = this.reachableFromInternet();
      for (const n of this.nodes.values()) {
        if (!reach.has(n.id) || this.isNodeDown(n)) continue;
        if (n.type === token) return true;
        if (token === 'app' && n.category === 'compute') return true;
        if (token === 'db' && n.category === 'database') return true;
        if (token === 'queue' && n.category === 'queue') return true;
        if (token === 'storage' && n.category === 'storage') return true;
        if (token === 'cache' && n.category === 'cache') return true;
        if (token === 'lb' && n.type === 'lb') return true;
      }
      return false;
    }

    hasNodesFor(token) {
      const reach = this.reachableFromInternet();
      const out = [];
      for (const n of this.nodes.values()) {
        if (!reach.has(n.id) || this.isNodeDown(n)) continue;
        if (n.type === token || (token === 'app' && n.category === 'compute') ||
            (token === 'db' && n.category === 'database') ||
            (token === 'queue' && n.category === 'queue') ||
            (token === 'cache' && n.category === 'cache')) out.push(n);
      }
      return out;
    }

    /* ------------------------------------------------------------------ */
    /* WAVES & EVENTS                                                      */
    /* ------------------------------------------------------------------ */
    currentWave() {
      return this.waves[this.waveIndex] || null;
    }

    waveProgress() {
      const w = this.currentWave();
      if (!w) return 1;
      return clamp(this.waveElapsed / w.durationMs, 0, 1);
    }

    enterWave(index, forceAttackId, forceFailureId) {
      this.waveIndex = index;
      this.waveElapsed = 0;
      this.waveNumber = index + 1;
      this.waveFlash = true;
      this._flashUntil = this.simTime + 700;
      const wave = this.currentWave();
      if (!wave) return;
      wave.started = true;
      wave.failureTriggered = false;
      wave.attackResolved = false;
      this.activeAttack = null;
      this.activeFailure = null;
      this.attackTargetId = null;
      this.mitigationNodeIds = [];
      this._attackErrorRate = 0;
      this._attackMultiplier = 1;
      this._attackMaliciousRatio = 0;
      this._attackMitigated = false;
      if (this.nodes.has('internet')) this.nodes.get('internet').downUntil = 0;

      const attack = forceAttackId ? D.ATTACK_BY_ID[forceAttackId] : wave.attack;
      if (attack) this.startAttack(attack);

      const failure = forceFailureId ? D.FAILURE_BY_ID[forceFailureId] : wave.failure;
      wave._forcedFailureId = forceFailureId || null;
      wave._forcedAttackId = forceAttackId || null;
      if (!failure) wave.failure = null;

      this.pushEvent({
        kind: 'wave', tone: 'info', icon: 'flag',
        message: `Wave ${index + 1}/${D.WAVES_PER_RUN} · ${wave.baseRps.toLocaleString()} base RPS · ${(wave.durationMs / 1000).toFixed(0)}s · ${wave.attack ? 'threat inbound' : 'no attack'}`,
      });
      if (failure) {
        // Stored on the wave, fired at the generated offset.
        wave.failure = failure;
      }
    }

    startAttack(attack) {
      const mitigatedTypes = attack.mitigations.filter((m) => this.has(m));
      const mitigated = mitigatedTypes.length > 0;
      const mitigationNodes = [];
      for (const m of mitigatedTypes) {
        for (const n of this.hasNodesFor(m)) if (!mitigationNodes.includes(n.id)) mitigationNodes.push(n.id);
      }
      const multi = mitigatedTypes.length >= 2;
      const reduction = mitigated ? (multi ? 0.985 : 0.88) : 0;
      const effMultiplier = attack.waveMultiplier > 1
        ? 1 + (attack.waveMultiplier - 1) * (1 - reduction)
        : 1;
      const slack = this.has('slack');
      const monitoring = this.has('monitoring');
      const repDamage = attack.repDamage * (mitigated ? (multi ? 0.06 : 0.16) : 1) *
        (slack ? 0.9 : 1) * (monitoring ? 0.82 : 1);
      this.reputation = clamp(this.reputation - repDamage, 0, 100);
      this._attackErrorRate = attack.errorRate * (mitigated ? (multi ? 0.04 : 0.14) : 1);
      this._attackMultiplier = effMultiplier;
      this._attackMaliciousRatio = mitigated ? attack.maliciousRatio * (multi ? 0.02 : 0.1) : attack.maliciousRatio;
      this._attackMitigated = mitigated;
      this.mitigationNodeIds = mitigationNodes;
      this.attackTargetId = this.pickAttackTarget(attack);
      if (mitigated) this.attacksMitigated++; else this.attacksMissed++;
      this.activeAttack = Object.assign({}, attack, {
        mitigated,
        mitigationTypes: mitigatedTypes,
        mitigationNodes,
        effectiveMultiplier: round(effMultiplier, 3),
        targetNodeId: this.attackTargetId,
      });
      this.attackHistory.push({
        id: attack.id, name: attack.name, wave: this.waveNumber,
        mitigated, mitigations: mitigatedTypes,
        missed: attack.mitigations.filter((m) => !mitigatedTypes.includes(m)),
      });

      const msg = mitigated
        ? `${attack.name} mitigated by ${mitigatedTypes.map((t) => this.labelForType(t)).join(' + ')}.`
        : `${attack.name} hit — ${attack.effectIfUnmitigated}`;
      this.pushEvent({
        kind: 'attack', tone: mitigated ? 'good' : 'bad', icon: attack.icon,
        title: attack.name, message: msg, teach: attack.teach,
        attackId: attack.id, slack: this.has('slack'),
        targetNodeId: this.attackTargetId,
      });
      if (this.reputation <= 0) {
        this.finish(false, 'Reputation hit zero after an unmitigated attack.');
        return;
      }

      // Some attacks try to force a node failure. Unmitigated = full; mitigated = hotfix-shortened.
      if (attack.forcedFailure) {
        if (!mitigated) {
          this.failuresSeen++;
          this.triggerFailure(attack.forcedFailure, null, this._lastFailureDuration(attack.forcedFailure));
        } else if (this.rng() < 0.45) {
          this.triggerFailure(attack.forcedFailure, null, this._lastFailureDuration(attack.forcedFailure) * 0.35);
        }
      }
    }

    pickAttackTarget(attack) {
      const candidates = Array.from(this.nodes.values()).filter((n) => !n.source);
      const pick = (filter) => {
        const list = candidates.filter(filter);
        return list.length ? list[Math.floor(this.rng() * list.length)] : null;
      };
      let n = null;
      if (attack.target === 'edge') n = pick((x) => ['cdn', 'lb', 'waf', 'shield', 'apigw', 'nat', 'internet'].includes(x.type) && x.type !== 'internet');
      else if (attack.target === 'app') n = pick((x) => x.category === 'compute');
      else if (attack.target === 'auth') n = pick((x) => x.type === 'auth') || pick((x) => x.category === 'compute');
      else if (attack.target === 'db') n = pick((x) => x.category === 'database');
      else if (attack.target === 'cache') n = pick((x) => x.category === 'cache');
      else if (attack.target === 'random') n = pick(() => true);
      if (!n) n = pick(() => true);
      return n ? n.id : null;
    }

    labelForType(type) {
      if (type === 'app') return 'Any App Server';
      if (type === 'db') return 'Any Database';
      if (type === 'queue') return 'Any Queue';
      if (type === 'cache') return 'Any Cache';
      if (type === 'storage') return 'Any Storage';
      const n = D.COMPONENTS;
      for (const k in n) if (n[k].type === type) return n[k].label;
      return type;
    }

    _lastFailureDuration(id) {
      const fd = D.FAILURE_BY_ID[id];
      return fd ? fd.durationMs : 12000;
    }

    /** Pick + start a random failure (separate from attack). */
    triggerFailure(failureId, targetId, durationOverride) {
      const def = D.FAILURE_BY_ID[failureId] || D.FAILURE_BY_ID.db_down;
      let target = null;
      if (targetId) target = this.nodes.get(targetId);
      if (!target) {
        let pool = [];
        if (def.target === 'database') pool = Array.from(this.nodes.values()).filter((n) => n.category === 'database' && n.baseWriteRPS > 0);
        else if (def.target === 'app') pool = Array.from(this.nodes.values()).filter((n) => n.category === 'compute');
        else if (def.target === 'cache') pool = Array.from(this.nodes.values()).filter((n) => n.category === 'cache');
        else if (def.target === 'queue') pool = Array.from(this.nodes.values()).filter((n) => n.category === 'queue');
        else if (def.target === 'lb') pool = Array.from(this.nodes.values()).filter((n) => n.type === 'lb');
        else if (def.target === 'network') pool = Array.from(this.nodes.values()).filter((n) => ['cdn', 'lb', 'apigw', 'waf', 'shield', 'nat'].includes(n.type));
        if (!pool.length) {
          this.pushEvent({ kind: 'failure', tone: 'warn', icon: 'shield-alert', title: def.name, message: 'No matching node existed, so the failure had no target.' });
          return null;
        }
        target = pool[Math.floor(this.rng() * pool.length)];
      }
      const hasCI = this.has('cicd');
      const hasMon = this.has('monitoring');
      const pool = this.getPoolCounts(); // healthy pools before the target goes down
      const otherApps = Math.max(0, pool.apps - (target.category === 'compute' ? 1 : 0));
      const otherLbs = Math.max(0, pool.lbs - (target.type === 'lb' ? 1 : 0));
      let mttr = durationOverride != null ? durationOverride : def.durationMs;
      if (hasCI) mttr *= 0.4;
      if (hasMon) mttr -= 3000;
      if (def.id === 'lb_down' && !hasCI) mttr = Math.max(mttr, 26000);
      mttr = Math.max(2500, mttr);
      const now = this.simTime;
      const failover = def.id === 'lb_down' && otherLbs > 0;
      target.downUntil = now + mttr;
      target.health = 0;
      target.failure = {
        id: def.id, name: def.name, start: now, duration: mttr,
        detectedAt: now + (hasMon ? 0 : 2000), detected: !!hasMon,
      };
      const failure = {
        id: def.id, name: def.name, targetId: target.id, targetLabel: target.label,
        start: now, duration: mttr, detectedAt: now + (hasMon ? 0 : 2000),
        def, active: true, otherLbs, otherApps, failover,
      };
      this.failures.push(failure);
      this.failuresSeen++;
      this.activeFailure = failure;
      if (def.id === 'network_partition') this.partitionUntil = now + mttr;
      if (def.id === 'lb_down') this.globalOutageUntil = now + (failover ? 1200 : mttr);
      const slack = this.has('slack');
      const repLoss = 2.5 * (slack ? 0.9 : 1) * (hasMon ? 0.8 : 1) * (failover ? 0.5 : 1);
      this.reputation = clamp(this.reputation - repLoss, 0, 100);
      let note = '';
      if (def.id === 'lb_down') {
        note = failover
          ? ` Redundant LB failover active: ${otherLbs} healthy LB${otherLbs > 1 ? 's' : ''}, ingress blip ~1.2s.`
          : ' No redundant LB: total ingress outage until recovery.';
      } else if (def.id === 'app_down') {
        note = otherApps > 0
          ? ` Traffic fails over to ${otherApps} remaining app server${otherApps > 1 ? 's' : ''}.`
          : ' No spare app server: no application capacity.';
      } else if (def.id === 'db_down') {
        note = pool.queues > 0
          ? ` ${pool.queues} queue${pool.queues > 1 ? 's are' : ' is'} buffering overflow.`
          : ' No queue is connected: overflow will drop immediately.';
      }
      const desc = def.id === 'lb_down' && failover
        ? 'Primary load balancer failed; a redundant LB is taking over.'
        : def.desc;
      this.pushEvent({
        kind: 'failure', tone: 'bad', icon: def.icon, title: def.name,
        message: `${target.label} failed for ${(mttr / 1000).toFixed(1)}s. ${desc}${note}`,
        slack, targetNodeId: target.id, failover,
      });
      if (this.reputation <= 0) this.finish(false, 'Reputation hit zero after a failure.');
      return failure;
    }

    /** If a player adds a redundant LB during an outage, fail over immediately. */
    checkFailoverRestore() {
      const f = this.activeFailure;
      if (!f || !f.def || f.def.id !== 'lb_down' || f.failover) return;
      const pool = this.getPoolCounts();
      if (pool.lbs > 0) {
        f.failover = true;
        f.otherLbs = pool.lbs;
        this.globalOutageUntil = Math.min(this.globalOutageUntil || Infinity, this.simTime + 1200);
        this.pushEvent({
          kind: 'system', tone: 'good', icon: 'network', title: 'LB failover restored',
          message: `Redundant load balancer detected - ingress resumes in ~1.2s.`,
          slack: this.has('slack'),
        });
      }
    }

    updateFailures() {
      for (const f of this.failures) {
        if (!f.active) continue;
        if (this.simTime >= f.start + f.duration) {
          f.active = false;
          const node = this.nodes.get(f.targetId);
          if (node) {
            node.downUntil = 0;
            node.health = 100;
            node.failure = null;
          }
          if (this.activeFailure === f) this.activeFailure = null;
          if (f.def.id === 'network_partition') this.partitionUntil = 0;
          if (f.def.id === 'lb_down') this.globalOutageUntil = 0;
          const hasGithub = this.has('github');
          let msg = `${f.name} on ${f.targetLabel} recovered.`;
          if (!hasGithub && (f.def.target === 'database')) {
            this.reputation = clamp(this.reputation - 6, 0, 100);
            msg += ' No GitHub rollback: data loss caused a reputation hit.';
          } else if (hasGithub && (f.def.target === 'database')) {
            msg += ' GitHub rollback restored the last good state.';
          }
          this.pushEvent({ kind: 'recovery', tone: 'good', icon: 'circle-check', title: 'Recovered', message: msg, slack: this.has('slack') });
        }
      }
    }

    pushEvent(ev) {
      const e = Object.assign({ id: `ev${this.events.length + 1}`, at: this.simTime, wave: this.waveNumber }, ev);
      this.events.unshift(e);
      if (this.events.length > 80) this.events.length = 80;
      return e;
    }

    consumeEvents() {
      const out = this.events.slice();
      this.events.length = 0;
      return out;
    }

    /* ------------------------------------------------------------------ */
    /* WAVE MOVEMENT                                                       */
    /* ------------------------------------------------------------------ */
    advanceWave() {
      if (this.waveIndex + 1 >= this.waves.length) {
        this.finish(true);
        return false;
      }
      const next = this.waveIndex + 1;
      this.enterWave(next);
      return true;
    }

    /** Test/debug helper: jump to a wave and fire its attack immediately. */
    forceWave(index, attackId, failureId) {
      if (index >= this.waves.length) return false;
      this.started = true;
      this.paused = false;
      this.enterWave(index, attackId, failureId);
      return true;
    }

    finish(victory, reason) {
      if (this.gameOver) return;
      this.gameOver = true;
      this.victory = !!victory;
      this.paused = true;
      this.gameOverReason = reason || (victory ? 'All 30 waves survived.' : 'Infrastructure exhausted.');
      this.lastScorecard = this.buildScorecard();
      this.pushEvent({
        kind: 'end', tone: victory ? 'good' : 'bad', icon: victory ? 'trophy' : 'skull',
        title: victory ? 'Gauntlet cleared' : 'Game over',
        message: this.gameOverReason,
      });
    }

    buildScorecard() {
      const idle = this.idleNodes();
      const missed = this.attackHistory.filter((a) => !a.mitigated);
      const recommend = new Set();
      for (const a of missed) {
        const def = D.ATTACK_BY_ID[a.id];
        if (!def) continue;
        const missing = def.mitigations.filter((m) => !this.has(m));
        if (missing[0]) recommend.add(this.labelForType(missing[0]));
      }
      if (idle.length) recommend.add('Connect or remove idle nodes');
      if (this.costPerHour > this.budgetPerHour) recommend.add('Lower cost per hour / take down idle nodes');
      if (this.availability < 80) recommend.add('Add capacity before the next wave');
      const overallAvail = this.totalDemandReq > 0 ? (this.totalServedReq / this.totalDemandReq) * 100 : 100;
      const score = Math.max(0, Math.round(
        this.wavesCompleted() * 1000 +
        this.peakServedRPS / 20 +
        this.reputation * 12 +
        this.attacksMitigated * 220 -
        this.attacksMissed * 80 -
        this.costSpent * 8
      ));
      return {
        victory: this.victory,
        reason: this.gameOverReason,
        wavesSurvived: this.wavesCompleted(),
        totalWaves: D.WAVES_PER_RUN,
        peakRps: Math.round(this.peakServedRPS),
        costSpent: round(this.costSpent, 3),
        costPerHour: round(this.costPerHour, 2),
        availability: round(overallAvail, 1),
        reputation: round(this.reputation, 0),
        attacksMitigated: this.attacksMitigated,
        attacksMissed: this.attacksMissed,
        failures: this.failuresSeen,
        score,
        recommendations: Array.from(recommend).slice(0, 7),
        idleNodes: idle.map((n) => n.label),
      };
    }

    wavesCompleted() {
      if (this.gameOver && this.victory) return D.WAVES_PER_RUN;
      return Math.max(0, this.waveIndex + (this.gameOver ? 0 : 0));
    }

    /* ------------------------------------------------------------------ */
    /* MAIN TICK                                                           */
    /* ------------------------------------------------------------------ */
    tick(dtSec) {
      if (this.gameOver || !this.started || this.paused) return this.metrics;
      if (this.reputation <= 0) {
        this.finish(false, 'Reputation hit zero.');
        return this.metrics;
      }
      const dt = dtSec == null ? D.TICK_MS / 1000 : dtSec;
      const dtMs = dt * 1000;
      this.simTime += dtMs;
      this.waveElapsed += dtMs;
      this.lastTickAt = this.simTime;

      // Wave timeline (advance before simulating the new wave).
      const wave = this.currentWave();
      if (wave && this.waveElapsed >= wave.durationMs) {
        if (this.waveIndex + 1 >= this.waves.length) {
          this.finish(true);
          return this.metrics;
        }
        this.advanceWave();
      }
      const cur = this.currentWave();
      if (!cur) return this.metrics;

      // Fire the scheduled failure once per wave (separate from attacks).
      if (!cur.failureTriggered && cur.failure && this.waveElapsed >= cur.failureTriggerAt) {
        cur.failureTriggered = true;
        this.triggerFailure(cur.failure.id);
      }

      this.updateFailures();
      this.checkFailoverRestore();
      this.recalculateCost();

      // Clear per-tick visuals.
      for (const n of this.nodes.values()) {
        n.readUsage = 0;
        n.writeUsage = 0;
        n.load = 0;
        n.backlog = Math.max(0, n.backlog || 0);
      }
      for (const e of this.edges.values()) e.flow = 0;

      // Drain existing queue backlog at the start of the tick. While a database
      // failure is active the downstream drain path is blocked, so messages
      // accumulate instead of vanishing — that is the backpressure signal.
      const dbFailureActive = this.failures.some((f) => f.active && f.def && f.def.target === 'database');
      if (!dbFailureActive) {
        for (const n of this.nodes.values()) {
          if (n.category !== 'queue' || this.isNodeDown(n)) continue;
          n.backlog = Math.max(0, (n.backlog || 0) - n.baseCapacityRPS * dt);
        }
      }

      const traffic = this.calculateTraffic(cur);
      // CDN absorbs static reads before origin routing (otherwise reads are double counted).
      const cdnServed = this.cdnStaticOffload(traffic.readRPS, {});
      const routing = this.routeTraffic(Math.max(0, traffic.readRPS - cdnServed), traffic.writeRPS, dt);
      let servedRPS = routing.servedRPS + cdnServed;
      const queuedAcceptedRPS = routing.queuedRPS;
      let droppedRPS = routing.droppedRPS;

      // Attack error injection reduces successful responses.
      const injectedErrorsRPS = traffic.demandRPS * this._attackErrorRate;
      servedRPS = Math.max(0, servedRPS - injectedErrorsRPS);
      const errorRPS = droppedRPS + injectedErrorsRPS;

      // Queue latency / backpressure snapshot.
      let queueDelaySec = 0;
      for (const n of this.nodes.values()) {
        if (n.category !== 'queue' || this.isNodeDown(n)) continue;
        queueDelaySec = Math.max(queueDelaySec, n.backlog / Math.max(1, n.baseCapacityRPS));
      }
      this.queueBacklog = Array.from(this.nodes.values()).reduce((s, n) => s + (n.backlog || 0), 0);

      // Capacity / load visualization.
      let maxUtil = 0;
      let weightedLatency = 0;
      let latencyWeight = 0;
      for (const n of this.nodes.values()) {
        if (n.type === 'internet') continue;
        const cap = this.nodeCapacity(n, 'read');
        const wcap = this.nodeCapacity(n, 'write');
        const used = Math.max(n.readUsage, n.writeUsage);
        const limit = Math.max(1, Math.max(cap === Infinity ? 1e12 : cap, wcap === Infinity ? 1e12 : wcap));
        n.load = clamp(used / limit, 0, 1.4);
        maxUtil = Math.max(maxUtil, n.load);
        if (used > 0 && n.latencyMs > 0 && n.type !== 'internet') {
          weightedLatency += n.latencyMs * used;
          latencyWeight += used;
        }
      }
      this.utilization = maxUtil;

      // Metrics.
      this.lastDemandRPS = traffic.demandRPS;
      this.lastServedRPS = servedRPS;
      this.lastDroppedRPS = droppedRPS;
      this.lastQueuedRPS = queuedAcceptedRPS;
      this.peakServedRPS = Math.max(this.peakServedRPS, servedRPS);
      this.tickAvailability = traffic.demandRPS > 0 ? clamp((servedRPS / traffic.demandRPS) * 100, 0, 100) : 100;
      this.availability = this.availability * 0.82 + this.tickAvailability * 0.18;
      const pathLatency = latencyWeight > 0 ? weightedLatency / latencyWeight : 0;
      const rawLatency = pathLatency + queueDelaySec * 1000 + maxUtil * 60 + (droppedRPS > 0 ? 250 : 0);
      this.latencyMs = this.latencyMs ? this.latencyMs * 0.7 + rawLatency * 0.3 : rawLatency;
      this.p99Ms = this.latencyMs * 2.2;
      const reqs = traffic.demandRPS * dt;
      this.totalDemandReq += reqs;
      this.totalServedReq += servedRPS * dt;
      this.totalDroppedReq += droppedRPS * dt;
      this.totalErrorReq += errorRPS * dt;
      this.totalQueuedReq += queuedAcceptedRPS * dt;
      this.errorRate = traffic.demandRPS > 0 ? clamp((errorRPS / traffic.demandRPS) * 100, 0, 100) : 0;

      // Reputation drift and cost.
      this.reputation = clamp(this.reputation + (this.tickAvailability > 96 ? 0.04 * dt : -0.05 * dt), 0, 100);
      this.costSpent += this.costPerHour * (dt / 3600);

      // Warnings + game-over conditions.
      this.updateWarnings();
      let instant = false;
      if (this.tickAvailability < 50) this.lowAvailMs += dtMs; else this.lowAvailMs = Math.max(0, this.lowAvailMs - dtMs);
      if (this.costPerHour > this.budgetPerHour) this.overBudgetMs += dtMs; else this.overBudgetMs = Math.max(0, this.overBudgetMs - dtMs);
      if (this.reputation <= 0) instant = true;
      if (this.lowAvailMs >= D.LOW_AVAIL_MS) instant = true;
      if (this.overBudgetMs >= D.OVER_BUDGET_MS) instant = true;
      if (instant) {
        let reason = 'Reputation is exhausted.';
        if (this.lowAvailMs >= D.LOW_AVAIL_MS) reason = 'Availability stayed below 50% for 15s.';
        else if (this.overBudgetMs >= D.OVER_BUDGET_MS) reason = 'Cost per hour stayed over budget for 30s.';
        this.finish(false, reason);
      }

      this.metrics = {
        rpsDemand: round(traffic.demandRPS, 0),
        rpsServed: round(servedRPS, 0),
        dropped: round(droppedRPS, 0),
        queued: round(queuedAcceptedRPS, 0),
        latencyMs: round(this.latencyMs, 0),
        p99Ms: round(this.p99Ms, 0),
        errorRate: round(this.errorRate, 2),
        availability: round(this.availability, 1),
        costPerHour: round(this.costPerHour, 2),
        costSpent: round(this.costSpent, 3),
        reputation: round(this.reputation, 1),
        utilization: round(this.utilization * 100, 0),
        queueBacklog: Math.round(this.queueBacklog),
        wave: this.waveNumber,
        waveProgress: round(this.waveProgress(), 3),
        seed: this.seedInput,
        gameOver: this.gameOver,
        victory: this.victory,
        topology: this.topologyLabel,
        capacityExhausted: droppedRPS > 0.5 || this.utilization >= 0.98,
      };
      return this.metrics;
    }

    calculateTraffic(wave) {
      const progress = clamp(this.waveElapsed / wave.durationMs, 0, 1);
      let burst = 1;
      if (wave.burstiness === 'spiky') {
        burst = this.rng() < 0.18 ? 1.6 + this.rng() * 0.9 : 0.65 + this.rng() * 0.7;
      } else if (wave.burstiness === 'step') {
        burst = progress < 0.5 ? 0.78 : 1.35;
      } else if (wave.burstiness === 'sine') {
        burst = 0.8 + 0.35 * Math.sin(progress * Math.PI * 2);
      } else {
        burst = 0.97 + 0.06 * Math.sin(progress * Math.PI);
      }
      const attackMult = this.activeAttack ? this._attackMultiplier : 1;
      const demand = wave.baseRps * burst * attackMult;
      return {
        demandRPS: demand,
        readRPS: demand * wave.readRatio,
        writeRPS: demand * wave.writeRatio,
        burst,
        attackMult,
        progress,
      };
    }

    cdnStaticOffload(readRPS, routing) {
      if (!readRPS) return 0;
      const reach = this.reachableFromInternet();
      const cdns = Array.from(this.nodes.values()).filter((n) => n.type === 'cdn' && reach.has(n.id) && !this.isNodeDown(n));
      if (!cdns.length) return 0;
      let remaining = readRPS;
      let served = 0;
      for (const cdn of cdns) {
        const cap = Math.max(0, this.nodeCapacity(cdn, 'read') - cdn.readUsage);
        const offload = Math.min(remaining * (cdn.staticOffload || 0), cap);
        served += offload;
        remaining -= offload;
        cdn.readUsage += offload;
        cdn.load = Math.min(1.4, cdn.readUsage / Math.max(1, cdn.baseCapacityRPS));
        if (offload > 0) {
          for (const e of this.edges.values()) {
            if (e.from === 'internet' && e.to === cdn.id) e.flow += offload;
          }
        }
      }
      routing.cdnServedRPS = served;
      return served;
    }

    /**
     * Enumerate simple directed paths from Internet to handler nodes.
     * Each path records node ids and edges so we can animate edge flows.
     */
    enumeratePaths(adj, healthyOnly) {
      healthyOnly = healthyOnly !== false;
      const paths = [];
      const source = this.nodes.get('internet');
      if (!source || this.isNodeDown(source)) return paths;
      const handler = (n) => n && !n.source && ['database', 'cache', 'storage'].includes(n.category);
      const maxDepth = 10;
      const maxPaths = 220;
      const walk = (node, nodePath, edgePath, visited) => {
        if (paths.length >= maxPaths) return;
        if (nodePath.length > 1 && handler(node)) {
          paths.push({ nodes: nodePath.slice(), edges: edgePath.slice(), terminalId: node.id });
          return;
        }
        if (nodePath.length >= maxDepth) return;
        const outgoing = adj.get(node.id) || [];
        for (const { edge, to } of outgoing) {
          if (visited.has(to)) continue;
          const next = this.nodes.get(to);
          if (!next) continue;
          if (healthyOnly && this.isNodeDown(next)) continue;
          visited.add(to);
          nodePath.push(to);
          edgePath.push(edge);
          walk(next, nodePath, edgePath, visited);
          nodePath.pop();
          edgePath.pop();
          visited.delete(to);
        }
      };
      walk(source, ['internet'], [], new Set(['internet']));
      // Deduplicate paths that hit the same terminal through identical nodes.
      const seen = new Set();
      return paths.filter((p) => {
        const k = p.nodes.join('>');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 180);
    }

    /**
     * Remaining capacity of a node for a request mode. App/network nodes have
     * one shared pool for reads + writes; databases have separate read/write
     * pools (read replicas vs shard primaries). This prevents an app tier from
     * being counted twice (once for reads and once for writes).
     */
    remainingNodeCapacity(n, mode, usage) {
      const c = this.nodeCapacity(n, mode);
      if (!isFinite(c)) return Infinity;
      const u = usage.get(n.id) || { read: 0, write: 0 };
      let used = u[mode];
      if (n.category === 'compute' || (n.category === 'network') || (n.category === 'cache' && mode === 'read')) {
        used = u.read + u.write;
      }
      return Math.max(0, c - used);
    }

    pathCapacity(path, mode, usage) {
      let cap = Infinity;
      for (let i = 1; i < path.nodes.length; i++) {
        const n = this.nodes.get(path.nodes[i]);
        if (!n || this.isNodeDown(n)) return 0;
        const c = this.remainingNodeCapacity(n, mode, usage);
        if (!isFinite(c)) continue;
        cap = Math.min(cap, c);
      }
      return cap;
    }

    isEmptyCapacity(path, mode, usage) {
      for (let i = 1; i < path.nodes.length; i++) {
        const n = this.nodes.get(path.nodes[i]);
        const c = this.remainingNodeCapacity(n, mode, usage);
        if (isFinite(c) && c <= 0.01) return true;
      }
      return false;
    }

    allocateAcrossPaths(paths, demandRPS, mode, usage, preference) {
      let remaining = demandRPS;
      let served = 0;
      for (let pass = 0; pass < 3 && remaining > 0.01; pass++) {
        const candidates = [];
        for (const p of paths) {
          if (this.isEmptyCapacity(p, mode, usage)) continue;
          const cap = this.pathCapacity(p, mode, usage);
          if (cap <= 0.01) continue;
          let w = Math.min(cap, 1000000);
          if (preference) w *= preference(p);
          candidates.push({ p, cap, w });
        }
        if (!candidates.length) break;
        const totalW = candidates.reduce((s, c) => s + c.w, 0);
        if (totalW <= 0) break;
        const allocations = candidates.map((c) => ({
          p: c.p, amount: (remaining * c.w) / totalW,
        }));
        // Scale down allocations that would over-drive any shared node.
        const nodeDelta = new Map();
        for (const a of allocations) {
          for (let i = 1; i < a.p.nodes.length; i++) {
            const id = a.p.nodes[i];
            const n = this.nodes.get(id);
            const c = this.nodeCapacity(n, mode);
            if (!isFinite(c) || c >= 1e8) continue;
            const cur = nodeDelta.get(id) || 0;
            nodeDelta.set(id, cur + a.amount);
          }
        }
        let scale = 1;
        for (const [id, delta] of nodeDelta.entries()) {
          const n = this.nodes.get(id);
          const room = this.remainingNodeCapacity(n, mode, usage);
          if (delta > room && delta > 0) scale = Math.min(scale, room / delta);
        }
        scale = clamp(scale, 0, 1);
        let passServed = 0;
        for (const a of allocations) {
          let amount = a.amount * scale;
          if (amount <= 0) continue;
          // Allocate edge flow and per-node usage.
          for (let i = 1; i < a.p.nodes.length; i++) {
            const id = a.p.nodes[i];
            if (!usage.has(id)) usage.set(id, { read: 0, write: 0 });
            const u = usage.get(id);
            if (mode === 'read') u.read += amount; else u.write += amount;
            const n = this.nodes.get(id);
            if (mode === 'read') n.readUsage += amount; else n.writeUsage += amount;
          }
          for (const e of a.p.edges) e.flow += amount;
          passServed += amount;
        }
        served += passServed;
        remaining -= passServed;
        if (passServed < 0.01) break;
      }
      return { served, remaining: Math.max(0, remaining) };
    }

    routeTraffic(readRPS, writeRPS, dt) {
      const usage = new Map();
      // Seed with usage from the edge (e.g. CDN static offload) so shared
      // node capacities are not spent twice.
      for (const n of this.nodes.values()) usage.set(n.id, { read: n.readUsage || 0, write: n.writeUsage || 0 });
      let served = 0;
      let dropped = 0;
      let queuedRPS = 0;
      let queueServed = 0;

      if (this.partitionUntil > this.simTime || this.globalOutageUntil > this.simTime) {
        // Network partition / LB outage: no ingress at all. Queues still drain.
        return { servedRPS: 0, droppedRPS: readRPS + writeRPS, queuedRPS: 0, pathInfo: [] };
      }
      const adj = this.adjacency(true);
      const paths = this.enumeratePaths(adj, true);
      const readPaths = paths.filter((p) => {
        const t = this.nodes.get(p.terminalId);
        return t && (t.category === 'database' || t.category === 'cache' || t.category === 'storage');
      });
      const writePaths = paths.filter((p) => {
        const t = this.nodes.get(p.terminalId);
        return t && (t.category === 'database' || t.category === 'storage');
      });
      // Prefer caches for reads and low-latency endpoints, but keep balancing.
      const readPref = (p) => {
        const t = this.nodes.get(p.terminalId);
        if (!t) return 1;
        if (t.category === 'cache') return 3.2;
        if (t.category === 'storage') return 0.8;
        return 1;
      };
      const writePref = () => 1;
      const readAlloc = this.allocateAcrossPaths(readPaths, readRPS, 'read', usage, readPref);
      const writeAlloc = this.allocateAcrossPaths(writePaths, writeRPS, 'write', usage, writePref);
      served += readAlloc.served + writeAlloc.served;
      const overflowRPS = readAlloc.remaining + writeAlloc.remaining;

      // Queues buffer overflow. Accepted messages count as handled with added latency.
      let overflow = overflowRPS;
      if (overflow > 0.01) {
        const queues = Array.from(this.nodes.values())
          .filter((n) => n.category === 'queue' && !this.isNodeDown(n) && this.reachableFromInternet().has(n.id))
          .sort((a, b) => b.bufferRPS - a.bufferRPS);
        for (const q of queues) {
          if (overflow <= 0.01) break;
          const maxBacklog = q.bufferRPS * q.maxBacklogSeconds;
          const space = Math.max(0, maxBacklog - (q.backlog || 0));
          if (space <= 0) continue;
          const offer = Math.min(overflow * dt, space, q.bufferRPS * dt);
          const acceptRPS = offer / dt;
          q.backlog = (q.backlog || 0) + offer;
          queuedRPS += acceptRPS;
          queueServed += acceptRPS;
          overflow -= acceptRPS;
        }
      }
      dropped = Math.max(0, overflow);
      served += queueServed;

      // Update per-node load for visualization.
      for (const n of this.nodes.values()) {
        if (n.type === 'internet') continue;
        const cap = Math.max(1, this.nodeCapacity(n, 'read'));
        const wcap = Math.max(1, this.nodeCapacity(n, 'write'));
        n.load = clamp(Math.max(n.readUsage, n.writeUsage) / Math.max(cap, wcap), 0, 1.4);
      }
      this._lastRouting = { readPaths, writePaths, usage, overflow: overflowRPS };
      return { servedRPS: served, droppedRPS: dropped, queuedRPS, queueServed, pathCount: paths.length };
    }

    /* ------------------------------------------------------------------ */
    /* WARNINGS / UI HELPERS                                               */
    /* ------------------------------------------------------------------ */
    updateWarnings() {
      const w = [];
      const idle = this.idleNodes();
      if (idle.length) {
        w.push({
          id: 'idle', severity: 'warn', icon: 'unplug', title: `${idle.length} idle node${idle.length > 1 ? 's' : ''}`,
          detail: `You're paying $${round(this.idleCostPerHour, 2)}/hr for nothing. They receive no traffic.`,
          action: 'highlight-idle', actionLabel: 'Show nodes',
        });
      }
      if (this.metrics && (this.metrics.capacityExhausted || this.lastDroppedRPS > 0.5)) {
        const pathFailure = this.utilization < 0.25 && this.lastDroppedRPS > 0.5;
        w.push({
          id: 'exhausted', severity: 'bad', icon: 'flame', title: 'CAPACITY EXHAUSTED',
          detail: pathFailure
            ? `${Math.round(this.lastDroppedRPS).toLocaleString()} RPS dropped — a failed/disconnected path is the bottleneck, not raw CPU.`
            : `${Math.round(this.lastDroppedRPS).toLocaleString()} RPS dropped · ${Math.round(this.utilization * 100)}% peak load. Add capacity, a queue, or take a node down deliberately.`,
          action: 'relieve', actionLabel: 'Under pressure?',
        });
      }
      if (this.queueBacklog > 1) {
        const secs = this.queueBacklog / Math.max(1, Array.from(this.nodes.values()).reduce((s, n) => s + (n.category === 'queue' ? n.bufferRPS : 0), 0) || 1);
        w.push({
          id: 'backlog', severity: 'warn', icon: 'layers', title: 'Queue backpressure',
          detail: `${Math.round(this.queueBacklog).toLocaleString()} messages buffered (~${secs.toFixed(1)}s). DB recovery is the drain valve.`,
        });
      }
      if (this.costPerHour > this.budgetPerHour) {
        w.push({
          id: 'budget', severity: 'bad', icon: 'circle-dollar-sign', title: 'OVER BUDGET',
          detail: `$${round(this.costPerHour, 2)}/hr > $${round(this.budgetPerHour, 2)}/hr · ${Math.max(0, 30 - this.overBudgetMs / 1000).toFixed(0)}s until shutdown.`,
          action: 'budget', actionLabel: 'Adjust budget',
        });
      } else if (this.costPerHour > this.budgetPerHour * 0.8) {
        w.push({
          id: 'budget-near', severity: 'warn', icon: 'circle-dollar-sign', title: 'Budget nearly exhausted',
          detail: `$${round(this.costPerHour, 2)}/hr of $${round(this.budgetPerHour, 2)}/hr budget used.`,
        });
      }
      if (this.utilization > 0.85 && !(this.metrics && this.metrics.capacityExhausted)) {
        w.push({
          id: 'near-capacity', severity: 'warn', icon: 'gauge', title: 'Capacity nearly exhausted',
          detail: `${Math.round(this.utilization * 100)}% peak load. Add a node or buffer before the next burst.`,
        });
      }
      if (this.availability < 70) {
        w.push({
          id: 'avail', severity: 'bad', icon: 'activity', title: 'Availability critical',
          detail: `Rolling ${round(this.availability, 1)}% · ${(this.lowAvailMs / 1000).toFixed(1)}s of sub-50% availability (shutdown at 15s).`,
        });
      }
      if (this.reputation < 30) {
        w.push({ id: 'rep', severity: 'bad', icon: 'thumbs-down', title: 'Reputation low', detail: `${Math.round(this.reputation)}/100 — at zero the run ends.` });
      }
      const rank = { bad: 0, warn: 1, info: 2 };
      w.sort((a, b) => (rank[a.severity] == null ? 3 : rank[a.severity]) - (rank[b.severity] == null ? 3 : rank[b.severity]));
      this.warnings = w;
      if (this.metrics) this.metrics.warnings = w;
    }

    /** Healthy, reachable pools used by the failover/runbook UI. */
    getPoolCounts() {
      const reach = this.reachableFromInternet();
      const healthy = (pred) => Array.from(this.nodes.values())
        .filter((n) => reach.has(n.id) && !this.isNodeDown(n) && pred(n)).length;
      return {
        apps: healthy((n) => n.category === 'compute'),
        lbs: healthy((n) => n.type === 'lb'),
        dbs: healthy((n) => n.category === 'database' && n.baseWriteRPS > 0),
        replicas: healthy((n) => n.type === 'replica'),
        caches: healthy((n) => n.category === 'cache'),
        queues: healthy((n) => n.category === 'queue'),
        cdns: healthy((n) => n.type === 'cdn'),
        total: this.nodes.size,
      };
    }

    getPressureNodes() {
      return Array.from(this.nodes.values())
        .filter((n) => n.type !== 'internet' && n.load > 0.8)
        .sort((a, b) => b.load - a.load);
    }

    /** Scale one node down a step (compute tier, custom cores, DB replicas/shards). */
    scaleDownNode(id) {
      const node = this.nodes.get(id);
      if (!node || node.type === 'internet') return null;
      const beforeCost = this.costPerHour;
      let detail = '';
      let removed = false;
      if (node.category === 'compute') {
        if (node.custom) {
          const old = node.config.cores;
          node.config.cores = Math.max(1, Math.floor(node.config.cores / 2));
          node.config.ram = Math.max(1, Math.floor(node.config.ram / 2));
          this.applyCustom(node);
          detail = `${node.label} scaled from ${old} to ${node.config.cores} vCPU. Capacity and cost both dropped.`;
        } else if (node.type !== 'app_1c') {
          const cores = node.config.cores || 1;
          const lower = [1, 2, 4, 8, 16, 32, 64, 128].filter((c) => c < cores).pop() || 1;
          const base = D.COMPONENT_BY_TYPE[`app_${lower}c`];
          node.type = base.type;
          node.label = base.label;
          node.baseCapacityRPS = base.baseCapacityRPS;
          node.costPerHour = base.costPerHour;
          node.config = Object.assign({}, base.config);
          detail = `${node.label} scaled down to ${lower}c. Cost and capacity dropped.`;
        } else {
          removed = this.removeNode(node.id);
          detail = `Smallest app server taken down. You pay less, but capacity is gone.`;
        }
      } else if (node.category === 'database' && node.baseWriteRPS > 0) {
        const s = this.dbStats(node);
        if (s.replicas > 0) {
          node.config.replicas = s.replicas - 1;
          detail = `${node.label} removed one read replica (${s.replicas} → ${s.replicas - 1}).`;
        } else if (s.shards > 1) {
          node.config.shards = s.shards - 1;
          detail = `${node.label} reduced to ${s.shards - 1} shards.`;
        } else {
          removed = this.removeNode(node.id);
          detail = `${node.label} taken down. Cost saved, data tier capacity gone.`;
        }
      } else {
        removed = this.removeNode(node.id);
        detail = `${node.label} taken down to relieve pressure.`;
      }
      this.recalculateCost();
      this.updateDerived();
      const relief = {
        nodeId: node.id, label: node.label, detail, beforeCost, afterCost: this.costPerHour,
        removed, load: node.load || 0,
      };
      this.lastRelief = relief;
      this.pushEvent({
        kind: 'scale', tone: 'warn', icon: 'arrow-down-to-line', title: 'Pressure relief',
        message: detail,
      });
      return relief;
    }

    /**
     * "Take the thing under pressure down" feature.
     * Scale the hottest node down one step. Returns a description, or null.
     */
    relievePressure() {
      const hot = this.getPressureNodes();
      if (!hot.length) return null;
      return this.scaleDownNode(hot[0].id);
    }
  }

  const API = {
    Engine, generateWaves, mulberry32, hashSeed, shuffled,
    version: '1.0.0',
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.IGEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);
