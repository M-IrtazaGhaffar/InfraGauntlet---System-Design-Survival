/* ============================================================================
 * InfraGauntlet — app.js
 * UI controller: Konva canvas, palette, panels, controls, warnings, modals.
 * Classic script so the game runs directly from file:// with no server.
 * ==========================================================================*/
(function () {
  'use strict';

  const D = window.IGData;
  const E = window.IGEngine;
  const ST = window.IGSelfTest;
  const TICK_MS = D.TICK_MS;
  const NODE_W = 172;
  const NODE_H = 82;
  const HALF_W = NODE_W / 2;
  const HALF_H = NODE_H / 2;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
  const money = (n, p) => '$' + (Number(n) || 0).toFixed(p == null ? 2 : p);
  const pct = (n, p) => (Number(n) || 0).toFixed(p == null ? 0 : p) + '%';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name) => `<i data-lucide="${esc(name)}"></i>`;
  const truncate = (s, n) => {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const PALETTE_META = {
    network: { short: 'Edge', blurb: 'Ingress, routing, scrubbing' },
    compute: { short: 'Compute', blurb: 'Application server tiers' },
    cache: { short: 'Cache', blurb: 'Edge and read acceleration' },
    database: { short: 'Data', blurb: 'Primary, shards, replicas' },
    queue: { short: 'Queue', blurb: 'Buffers and backpressure' },
    storage: { short: 'Storage', blurb: 'Objects and backups' },
    devops: { short: 'Ops', blurb: 'Delivery and alerting' },
    security: { short: 'Security', blurb: 'Auth, secrets, intrusion' },
  };
  const toPascal = (s) => String(s || '').replace(/(^\w|-\w)/g, (m) => m.replace('-', '').toUpperCase());
  const hexToRgba = (hex, alpha) => {
    const h = String(hex || '#4ef0b4').replace('#', '');
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };

  /* ------------------------------------------------------------------ */
  /* STATE                                                               */
  /* ------------------------------------------------------------------ */
  const state = {
    engine: null,
    stage: null,
    layers: {},
    nodeGroups: new Map(),
    edgeShapes: new Map(),
    tempArrow: null,
    selectedId: null,
    linkingFrom: null,
    speed: 1,
    timer: null,
    seenEvents: new Set(),
    lastWaveIndex: -1,
    gameOverShown: false,
    configSig: '',
    warnSig: '',
    attackSig: '',
    feedSig: '',
    dragType: null,
    dragEndedAt: 0,
    spaceHeld: false,
    userZoomed: false,
    fitDone: false,
    modalKind: null,
    modalDismissible: true,
    confirmCb: null,
    contextEdgeKey: null,
    highlightIdleUntil: 0,
    seenDown: new Set(),
    exhaustToastAt: 0,
    selfTestBusy: false,
    costShown: 0,
    costTarget: 0,
    paletteCategory: 'network',
    spawnNodeId: null,
    particles: new Map(),
    dragDepth: 0,
    runbookSig: '',
    booted: false,
  };

  let iconRaf = 0;
  function refreshIcons() {
    cancelAnimationFrame(iconRaf);
    iconRaf = requestAnimationFrame(() => {
      try {
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
      } catch (err) {
        /* icons are cosmetic; never break the game over one missing glyph */
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* BOOT                                                                */
  /* ------------------------------------------------------------------ */
  function boot() {
    buildPalette();
    setupStage();
    bindUI();
    const seed = randomSeed();
    loadNewGame(seed, { start: false, announce: false });
    state.booted = true;
    requestAnimationFrame(() => {
      resizeCanvas();
      fitGraph();
      refreshIcons();
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (state.stage && state.engine) {
          renderGraph();
          renderAll(true);
        }
      });
    }
    setInterval(() => {
      /* keeps the clock display accurate while paused */
      if (state.engine && !state.engine.paused && state.engine.started) updateClockOnly();
    }, 250);
  }

  function randomSeed() {
    return Math.floor(100000 + Math.random() * 900000);
  }

  function loadNewGame(seed, opts) {
    opts = opts || {};
    stopTimer();
    if (state.stage) {
      state.layers.node.destroyChildren();
      state.layers.edge.destroyChildren();
      state.layers.fx.destroyChildren();
      state.layers.link.destroyChildren();
      if (state.layers.traffic) state.layers.traffic.destroyChildren();
    }
    state.nodeGroups.clear();
    state.edgeShapes.clear();
    state.particles.clear();
    state.spawnNodeId = null;
    state.tempArrow = null;
    state.engine = new E.Engine({ seed: seed });
    state.engine.budgetPerHour = 5;
    state.costShown = state.engine.costPerHour;
    state.costTarget = state.engine.costPerHour;
    state.selectedId = null;
    state.linkingFrom = null;
    state.seenEvents = new Set();
    state.lastWaveIndex = -1;
    state.gameOverShown = false;
    state.configSig = '';
    state.warnSig = '';
    state.attackSig = '';
    state.feedSig = '';
    state.highlightIdleUntil = 0;
    state.seenDown = new Set();
    state.exhaustToastAt = 0;
    $('#seedInput').value = String(seed);
    $('#budgetRange').value = '5';
    $('#budgetVal').textContent = '$5/hr';
    $('#hintTooltip').classList.remove('hidden');
    buildTimelineSegments();
    renderGraph();
    renderAll(true);
    updateButtons();
    if (opts.start) startGame();
    if (opts.announce) toast({ tone: 'info', icon: 'refresh-cw', title: 'New seeded run', message: `Seed ${seed} loaded. Starting graph is unconnected.` });
  }

  /* ------------------------------------------------------------------ */
  /* RENDERING HELPERS                                                   */
  /* ------------------------------------------------------------------ */
  function setIcon(host, name) {
    if (!host) return;
    if (host.dataset.icon === name) return;
    host.dataset.icon = name;
    host.innerHTML = icon(name);
    refreshIcons();
  }

  function toast(opts) {
    const host = $('#toastHost');
    if (!host) return;
    const tone = opts.tone || 'info';
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.innerHTML = `
      <div class="t-icon">${icon(opts.icon || 'info')}</div>
      <div style="min-width:0">
        <div class="t-title">${esc(opts.title || 'Notice')}</div>
        ${opts.message ? `<div class="t-msg">${esc(opts.message)}</div>` : ''}
        <div class="t-time">wave ${state.engine ? state.engine.waveNumber : 1} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
      </div>`;
    host.appendChild(el);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(8px)';
      setTimeout(() => el.remove(), 280);
    }, opts.duration || 4600);
    refreshIcons();
  }

  function processEvents() {
    if (!state.engine) return;
    const unseen = state.engine.events.filter((ev) => !state.seenEvents.has(ev.id)).reverse();
    for (const ev of unseen) {
      state.seenEvents.add(ev.id);
      if (ev.kind === 'attack') {
        toast({
          tone: ev.tone || 'bad', icon: ev.icon || 'siren', title: ev.title,
          message: ev.message + (ev.slack ? ' · posted to Slack #incidents' : ''),
          duration: 6200,
        });
        if (ev.targetNodeId) spawnSparks(ev.targetNodeId, '#fb7185');
        flashWave();
      } else if (ev.kind === 'failure') {
        toast({ tone: 'bad', icon: ev.icon || 'triangle-alert', title: ev.title, message: ev.message + (ev.slack ? ' · Slack page sent' : ''), duration: 5600 });
        if (ev.targetNodeId) spawnSparks(ev.targetNodeId, '#f87171');
      } else if (ev.kind === 'recovery' || ev.kind === 'scale') {
        toast({ tone: ev.kind === 'scale' ? 'warn' : 'good', icon: ev.icon, title: ev.title, message: ev.message });
      } else if (ev.kind === 'end') {
        /* scorecard modal is opened by afterTick */
      }
    }
  }

  function renderAll(force) {
    if (!state.engine) return;
    renderMetrics();
    renderWarnings();
    renderTimeline();
    renderAttackCard(force);
    renderRunbook(force);
    renderConfigPanel(force);
    renderOpsFeed(force);
    renderHint();
    updateGraphVisuals();
    updateButtons();
    updateClockOnly();
  }

  function updateButtons() {
    const e = state.engine;
    if (!e) return;
    const started = e.started && !e.gameOver && !e.victory;
    const start = $('#btnStart');
    const pause = $('#btnPause');
    if (e.gameOver || e.victory) {
      start.disabled = false;
      start.innerHTML = `${icon('rotate-ccw')} Run again`;
      pause.disabled = true;
      pause.innerHTML = `${icon('pause')} Pause`;
      pause.classList.remove('primary');
      start.classList.add('primary');
    } else if (!e.started) {
      start.disabled = false;
      start.innerHTML = `${icon('play')} Start`;
      start.classList.add('primary');
      pause.disabled = true;
      pause.innerHTML = `${icon('pause')} Pause`;
      pause.classList.remove('primary');
    } else if (e.paused) {
      start.disabled = true;
      start.innerHTML = `${icon('play')} Paused`;
      start.classList.remove('primary');
      pause.disabled = false;
      pause.innerHTML = `${icon('play')} Resume`;
      pause.classList.add('primary');
    } else {
      start.disabled = true;
      start.innerHTML = `${icon('play')} Running`;
      start.classList.remove('primary');
      pause.disabled = false;
      pause.innerHTML = `${icon('pause')} Pause`;
      pause.classList.remove('primary');
    }
    $$('#speedToggle button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === state.speed));
    const reset = $('#btnReset');
    if (reset) reset.innerHTML = `${icon('rotate-ccw')} Reset`;
    refreshIcons();
  }

  function renderMetrics() {
    const e = state.engine;
    if (!e) return;
    const m = e.metrics || {};
    const served = Math.round(e.lastServedRPS || 0);
    const demand = Math.round(e.lastDemandRPS || 0);
    const p99 = Math.round(e.p99Ms || 0);
    const err = Number(e.errorRate || 0);
    const avail = Number(e.availability == null ? 100 : e.availability);
    const cost = Number(e.costPerHour || 0);
    const rep = Number(e.reputation || 0);
    const load = Math.round((e.utilization || 0) * 100);
    $('#rpsVal').textContent = fmt(served);
    $('#rpsSub').textContent = `${fmt(demand)} demand · ${fmt(e.lastDroppedRPS || 0)} drop`;
    $('#latVal').textContent = p99 >= 1000 ? (p99 / 1000).toFixed(1) + 's' : p99 + 'ms';
    $('#latSub').textContent = `p99 · ${Math.round(e.latencyMs || 0)}ms avg`;
    $('#errVal').textContent = err.toFixed(1) + '%';
    $('#errSub').textContent = `${fmt(e.lastDroppedRPS || 0)} dropped RPS`;
    $('#availVal').textContent = avail.toFixed(1) + '%';
    $('#availSub').textContent = e.lowAvailMs > 0 ? `${(e.lowAvailMs / 1000).toFixed(1)}s below 50%` : 'rolling window';
    state.costTarget = cost;
    $('#costSub').textContent = `budget ${money(e.budgetPerHour, 0)}/hr · spent ${money(e.costSpent, 3)}`;
    $('#repVal').textContent = Math.round(rep);
    $('#repSub').textContent = rep < 30 ? 'dangerously low' : rep < 70 ? 'damaged trust' : 'healthy';
    $('#loadVal').textContent = load + '%';
    $('#loadSub').textContent = e.lastQueuedRPS > 0 ? `${fmt(e.lastQueuedRPS)} queued` : (e.capacityExhausted ? 'exhausted' : 'capacity');
    $('#waveVal').textContent = `${e.waveNumber}/${D.WAVES_PER_RUN}`;
    $('#waveSub').textContent = `seed ${e.seedInput} · ${e.started ? (e.paused ? 'paused' : 'live') : 'ready'}`;
    const topo = $('#topologyName');
    if (topo) topo.textContent = e.topologyLabel || 'Disconnected';

    setMetricState('#mRps', e.capacityExhausted ? 'bad' : (e.lastDroppedRPS > 0 ? 'warn' : ''));
    setMetricState('#mLat', p99 > 900 ? 'bad' : p99 > 350 ? 'warn' : '');
    setMetricState('#mErr', err > 20 ? 'bad' : err > 5 ? 'warn' : '');
    setMetricState('#mAvail', avail < 50 ? 'bad' : avail < 85 ? 'warn' : '');
    setMetricState('#mCost', cost > e.budgetPerHour ? 'bad' : cost > e.budgetPerHour * 0.8 ? 'warn' : '');
    setMetricState('#mRep', rep < 25 ? 'bad' : rep < 60 ? 'warn' : '');
    setMetricState('#mLoad', load > 98 ? 'bad' : load > 80 ? 'warn' : '');
    setMetricState('#mWave', '');
    renderAttackBadge();
  }

  function setMetricState(sel, kind) {
    const el = $(sel);
    if (!el) return;
    el.classList.remove('warn', 'bad');
    if (kind) el.classList.add(kind);
  }

  function renderAttackBadge() {
    const e = state.engine;
    const badge = $('#attackBadge');
    const a = e.activeAttack;
    if (a) {
      badge.className = 'attack-badge ' + (a.mitigated ? 'mitigated' : 'live');
      $('#attackKicker').textContent = a.mitigated ? 'MITIGATED' : 'UNDER ATTACK';
      $('#attackName').textContent = a.name;
      setIcon($('.ab-icon', badge), a.icon);
    } else if (e.activeFailure) {
      badge.className = 'attack-badge live';
      $('#attackKicker').textContent = 'INCIDENT';
      $('#attackName').textContent = e.activeFailure.name;
      setIcon($('.ab-icon', badge), e.activeFailure.def.icon);
    } else {
      badge.className = 'attack-badge';
      $('#attackKicker').textContent = 'THREAT';
      $('#attackName').textContent = e.started ? 'All quiet' : 'Standby';
      setIcon($('.ab-icon', badge), 'shield-check');
    }
  }

  /* ------------------------------------------------------------------ */
  /* WARNINGS                                                            */
  /* ------------------------------------------------------------------ */
  function renderWarnings() {
    const host = $('#warningStack');
    const e = state.engine;
    if (!host || !e) return;
    // Re-evaluate after graph mutations too (add / delete / rewire) even when
    // the simulation is paused, so the idle-cost warning is immediate.
    e.updateWarnings();
    const warnings = (e.warnings || []).slice(0, 3);
    // Immediate no-route warning is independent of the simulation warnings.
    const hasRoute = e.edges.has('internet|app') && e.edges.has('app|db');
    if (e.started && !hasRoute && !e.gameOver) {
      warnings.unshift({ id: 'noroute', severity: 'bad', icon: 'unplug', title: 'NO TRAFFIC PATH', detail: 'Connect Internet → App → DB. Availability is falling until a route exists.' });
    }
    const sig = warnings.map((w) => `${w.id}:${w.title}:${w.detail}`).join('|');
    if (sig === state.warnSig) return;
    state.warnSig = sig;
    host.innerHTML = warnings.map((w) => `
      <div class="warning ${w.severity === 'bad' ? 'bad' : ''}">
        <span class="w-icon">${icon(w.icon || 'triangle-alert')}</span>
        <span class="w-title">${esc(w.title)}</span>
        <span class="w-detail">${esc(w.detail)}</span>
        ${w.action ? `<button class="w-action" data-action="${esc(w.action)}">${esc(w.actionLabel || 'Fix')}</button>` : ''}
      </div>`).join('');
    refreshIcons();
  }

  /* ------------------------------------------------------------------ */
  /* THREAT / TEACH CARD                                                 */
  /* ------------------------------------------------------------------ */
  function renderAttackCard(force) {
    const e = state.engine;
    if (!e) return;
    const a = e.activeAttack;
    const f = e.activeFailure;
    const next = e.currentWave();
    const sig = a ? `a:${a.id}:${a.mitigated}:${f ? f.id : ''}:${e.waveNumber}` : `q:${e.waveNumber}:${f ? f.id : ''}:${!!next}`;
    if (!force && sig === state.attackSig) return;
    state.attackSig = sig;
    const card = $('#threatCard');
    let head = `
      <div class="card-head">
        <i class="ch-icon" data-lucide="siren"></i>
        <div class="ch-title">Current Threat</div>
        <div class="ch-right">${a ? `<span class="badge ${a.mitigated ? 'ok' : 'bad'}">${a.mitigated ? icon('shield-check') + ' Mitigated' : icon('siren') + ' Unmitigated'}</span>` : f ? `<span class="badge warn">${icon('triangle-alert')} Incident</span>` : `<span class="badge dim">${icon('moon')} Quiet</span>`}</div>
      </div>`;
    let body = '';
    if (a) {
      const missing = a.mitigations.filter((m) => !a.mitigationTypes.includes(m));
      body = `
        <div class="card-body">
          <div class="threat-title">
            <div class="threat-icon ${a.mitigated ? 'mitigated' : ''}">${icon(a.icon)}</div>
            <div style="min-width:0">
              <div class="threat-name">${esc(a.name)}</div>
              <div class="threat-meta">wave ${e.waveNumber} · ${esc(a.category)} · target ${esc(a.targetLayer)} · ×${a.effectiveMultiplier} traffic</div>
            </div>
          </div>
          <div class="teach-box">${esc(a.teach)}</div>
          <div class="effect-line"><b>${a.mitigated ? 'Mitigated:' : 'Impact:'}</b> ${esc(a.mitigated ? a.effectIfMitigated : a.effectIfUnmitigated)}</div>
          <div class="mit-chips">
            ${a.mitigations.map((m) => `<span class="mit-chip ${a.mitigationTypes.includes(m) ? 'have' : 'miss'}">${icon(a.mitigationTypes.includes(m) ? 'check' : 'x')} ${esc(e.labelForType(m))}</span>`).join('')}
          </div>
          ${!a.mitigated && missing.length ? `<div class="tiny" style="margin-top:5px;color:#fca5a5">Next time add: ${missing.slice(0, 3).map((m) => esc(e.labelForType(m))).join(', ')}</div>` : ''}
          ${f ? `<div class="pressure-note" style="border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.06);color:#fecaca;margin-top:6px"><b>${esc(f.name)}</b> · ${esc(f.targetLabel)} recovering in ${Math.max(0, (f.start + f.duration - e.simTime) / 1000).toFixed(1)}s</div>` : ''}
        </div>`;
    } else {
      const w = next || {};
      body = `
        <div class="card-body">
          <div class="threat-title">
            <div class="threat-icon mitigated">${icon(f ? f.def.icon : 'moon')}</div>
            <div>
              <div class="threat-name">${f ? esc(f.name) : 'No active attack'}</div>
              <div class="threat-meta">${next ? `wave ${e.waveNumber} · ${fmt(next.baseRps)} base RPS · ${next.burstiness} · ${(next.durationMs / 1000).toFixed(0)}s` : 'run complete'}</div>
            </div>
          </div>
          <div class="teach-box">${f ? esc(f.def.desc) : 'Quiet waves still charge cost. Use them to add capacity and reconnect nodes before the next spike.'}</div>
          <div class="effect-line"><b>Business:</b> ${fmt(e.lastServedRPS || 0)} RPS served, ${fmt(e.lastDemandRPS || 0)} demanded. Every node charges cost whether connected or not.</div>
        </div>`;
    }
    card.innerHTML = head + body;
    refreshIcons();
  }

  /* ------------------------------------------------------------------ */
  /* INCIDENT RUNBOOK                                                    */
  /* ------------------------------------------------------------------ */
  function runbookData(f, e) {
    const pools = e.getPoolCounts();
    const remaining = Math.max(0, (f.start + f.duration - e.simTime) / 1000);
    const name = f.def ? f.def.id : f.id;
    const steps = [];
    let action = null;
    if (name === 'app_down') {
      steps.push(pools.apps > 0
        ? `Traffic has failed over to ${pools.apps} healthy app server${pools.apps > 1 ? 's' : ''}. Confirm the load balancer still has targets.`
        : 'No healthy app server remains. Deploy a spare app server now and wire it to the database.');
      steps.push('Keep the queue and cache healthy; do not take down more application capacity.');
      steps.push(`CI/CD recovery is running — ETA ${remaining.toFixed(1)}s. Monitor the pool instead of panic-scaling.`);
      action = { id: 'runbook-add-app', label: 'Deploy spare app' };
    } else if (name === 'lb_down') {
      steps.push(f.failover
        ? `Secondary load balancer is carrying ingress after a ~1.2s failover blip (${f.otherLbs} healthy LB${f.otherLbs > 1 ? 's' : ''}).`
        : 'No secondary load balancer: ingress is fully down. Add a redundant LB and attach it to Internet.');
      steps.push('Do not take down the database or cache while ingress is failing over — keep the serving layers warm.');
      steps.push(f.failover
        ? `CI/CD recovery ETA ${remaining.toFixed(1)}s. Ride out the recovery; keep the redundant LB in place.`
        : `CI/CD recovery ETA ${remaining.toFixed(1)}s. Add the second LB now — it is detected immediately during the outage.`);
      action = { id: 'runbook-add-lb', label: f.failover ? 'Add another LB' : 'Add redundant LB' };
    } else if (name === 'db_down') {
      steps.push(pools.queues > 0
        ? `${pools.queues} queue${pools.queues > 1 ? 's are' : ' is'} absorbing overflow. Keep the buffer alive; do not scale down the queue.`
        : 'No queue is connected, so overflow is dropping. Add Kafka or RabbitMQ to buffer.');
      steps.push(`Read replicas: ${pools.replicas}. Writes still need a primary; do not take down the surviving DB.`);
      steps.push(`CI/CD recovery ETA ${remaining.toFixed(1)}s. GitHub rollback protects the last good state.`);
      action = { id: 'runbook-add-queue', label: pools.queues ? 'Add buffer capacity' : 'Add queue' };
    } else if (name === 'cache_down') {
      steps.push('Reads are falling through to the database. Watch DB utilization and p99 latency.');
      steps.push(pools.replicas > 0 ? 'A read replica is available; route read traffic there.' : 'Add a read replica to absorb the read spike before DB saturation.');
      steps.push(`Cache recovery ETA ${remaining.toFixed(1)}s. Keep the primary DB capacity stable.`);
      action = { id: 'runbook-add-replica', label: 'Add read replica' };
    } else if (name === 'queue_down') {
      steps.push('Buffering is gone. The next DB or traffic spike will drop requests immediately.');
      steps.push('Add a second queue or reduce incoming load with the API Gateway / LB.');
      steps.push(`Queue recovery ETA ${remaining.toFixed(1)}s.`);
      action = { id: 'runbook-add-queue', label: 'Add second queue' };
    } else if (name === 'network_partition') {
      steps.push('The edge is partitioned. No local config change can restore routing instantly.');
      steps.push('Hold capacity and let the route reconverge; avoid scaling down healthy nodes during the blind window.');
      steps.push(`Partition recovery ETA ${remaining.toFixed(1)}s.`);
    } else {
      steps.push('Keep the serving path healthy and wait for automatic recovery.');
      steps.push(`Recovery ETA ${remaining.toFixed(1)}s.`);
    }
    return { pools, remaining, steps, action };
  }

  function renderRunbook(force) {
    const host = $('#runbookCard');
    const e = state.engine;
    if (!host || !e) return;
    const f = e.activeFailure;
    if (!f) {
      host.classList.add('hidden');
      host.innerHTML = '';
      state.runbookSig = 'none';
      return;
    }
    const data = runbookData(f, e);
    const sig = `${f.id}:${Math.ceil(data.remaining)}:${data.pools.apps}:${data.pools.lbs}:${data.pools.dbs}:${data.pools.queues}:${f.failover}`;
    if (!force && sig === state.runbookSig) return;
    state.runbookSig = sig;
    host.classList.remove('hidden');
    host.innerHTML = `
      <div class="card-head">
        <i class="ch-icon" data-lucide="clipboard-list"></i>
        <div class="ch-title">Incident Runbook</div>
        <div class="ch-right"><span class="badge bad">${icon('siren')} Live</span></div>
      </div>
      <div class="card-body">
        <div class="runbook-hero">
          <div class="runbook-icon">${icon(f.def ? f.def.icon : 'triangle-alert')}</div>
          <div style="min-width:0">
            <div class="runbook-title">${esc(f.name)}<span>target · ${esc(f.targetLabel)}</span></div>
            <div class="runbook-eta">auto-recovery in ${data.remaining.toFixed(1)}s ${f.failover ? '· failover active' : ''}</div>
          </div>
        </div>
        <ol class="runbook-steps">
          ${data.steps.map((s) => `<li>${esc(s)}</li>`).join('')}
        </ol>
        <div class="runbook-pools">
          <span>Apps <b>${data.pools.apps}</b></span>
          <span>LBs <b class="${data.pools.lbs ? 'ok' : 'bad'}">${data.pools.lbs}</b></span>
          <span>DBs <b class="${data.pools.dbs ? 'ok' : 'bad'}">${data.pools.dbs}</b></span>
          <span>Queues <b class="${data.pools.queues ? 'ok' : 'dim'}">${data.pools.queues}</b></span>
        </div>
        <div class="btn-row">
          ${data.action ? `<button class="btn mini primary" data-runbook="${data.action.id}">${icon(data.action.id === 'runbook-add-lb' ? 'network' : data.action.id === 'runbook-add-queue' ? 'layers' : data.action.id === 'runbook-add-replica' ? 'copy' : 'server')} ${esc(data.action.label)}</button>` : ''}
          <button class="btn mini danger" data-action="open-pressure">${icon('gauge')} Pressure controls</button>
        </div>
      </div>`;
    refreshIcons();
  }

  /* ------------------------------------------------------------------ */
  /* OPS FEED                                                            */
  /* ------------------------------------------------------------------ */
  function renderOpsFeed(force) {
    const e = state.engine;
    if (!e) return;
    const slackOn = e.has('slack');
    const badge = $('#slackBadge');
    badge.className = `badge ${slackOn ? 'ok' : 'dim'}`;
    badge.innerHTML = slackOn ? `${icon('bell')} Slack on` : `${icon('bell-off')} Slack off`;
    const events = e.events.slice(0, 9);
    const sig = events.map((x) => x.id).join(',') + ':' + slackOn;
    if (!force && sig === state.feedSig) return;
    state.feedSig = sig;
    const host = $('#opsFeed');
    if (!events.length) {
      host.innerHTML = '<div class="empty-note">No operational events yet. Start a run and connect the graph.</div>';
    } else {
      host.innerHTML = events.map((ev) => {
        const tone = ev.tone || 'info';
        return `<div class="feed-item ${tone}">
          <span>${icon(ev.icon || 'info')}</span>
          <div class="fi-msg">
            ${ev.title ? `<span class="fi-title">${esc(ev.title)}</span> ` : ''}${esc(ev.message)}
            ${ev.slack ? `<span class="slack-tag">${icon('hash')} #incidents</span>` : ''}
            <div class="fi-meta">wave ${ev.wave || 1} · ${fmtTime(ev.at)}</div>
          </div>
        </div>`;
      }).join('');
    }
    refreshIcons();
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------------ */
  /* TIMELINE / HINT                                                     */
  /* ------------------------------------------------------------------ */
  function buildTimelineSegments() {
    const host = $('#timelineSegments');
    if (!host || !state.engine) return;
    host.innerHTML = state.engine.waves.map((w) =>
      `<i class="${w.attack ? 'threat' : ''}" title="Wave ${w.index + 1}: ${fmt(w.baseRps)} RPS${w.attack ? ' · ' + esc(w.attack.name) : ''}${w.failure ? ' · ' + esc(w.failure.name) : ''}"></i>`
    ).join('');
  }

  function renderTimeline() {
    const e = state.engine;
    if (!e || !e.currentWave()) return;
    const progress = e.waveIndex + e.waveProgress();
    const pctDone = e.victory ? 100 : clamp((progress / D.WAVES_PER_RUN) * 100, 0, 100);
    $('#timelineFill').style.width = pctDone.toFixed(1) + '%';
    $('#timelineWave').textContent = e.waveNumber;
    $('#waveTime').textContent = `${(e.waveElapsed / 1000).toFixed(1)}s / ${(e.currentWave().durationMs / 1000).toFixed(0)}s`;
    $('#timelineMeta').innerHTML = `seed <b>${esc(String(e.seedInput))}</b> · <span id="waveTime">${(e.waveElapsed / 1000).toFixed(1)}s / ${(e.currentWave().durationMs / 1000).toFixed(0)}s</span> · ${e.attacksMitigated} mitigated / ${e.attacksMissed} missed`;
  }

  function updateClockOnly() {
    const e = state.engine;
    const clock = $('#waveTime');
    if (!e || !clock || !e.currentWave()) return;
    clock.textContent = `${(e.waveElapsed / 1000).toFixed(1)}s / ${(e.currentWave().durationMs / 1000).toFixed(0)}s`;
  }

  function renderHint() {
    const e = state.engine;
    if (!e) return;
    const hint = $('#hintTooltip');
    const hasPath = e.edges.has('internet|app') && e.edges.has('app|db');
    const show = !hasPath && !e.gameOver && !state.linkingFrom;
    hint.classList.toggle('hidden', !show);
    if (show) {
      hint.innerHTML = `${icon('mouse-pointer-click')}<span><b>Connect Internet → App → DB</b> to serve traffic${e.started ? ' — availability is dropping' : ''}</span>`;
      refreshIcons();
    }
  }

  /* ------------------------------------------------------------------ */
  /* GRAPH — KONVA                                                       */
  /* ------------------------------------------------------------------ */
  function setupStage() {
    const host = $('#canvasHost');
    const stage = new Konva.Stage({
      container: host,
      width: Math.max(320, host.clientWidth),
      height: Math.max(240, host.clientHeight),
    });
    state.stage = stage;
    state.layers.background = new Konva.Layer({ listening: false });
    state.layers.edge = new Konva.Layer();
    state.layers.traffic = new Konva.Layer({ listening: false });
    state.layers.node = new Konva.Layer();
    state.layers.link = new Konva.Layer({ listening: false });
    state.layers.fx = new Konva.Layer({ listening: false });
    stage.add(state.layers.background);
    stage.add(state.layers.edge);
    stage.add(state.layers.traffic);
    stage.add(state.layers.node);
    stage.add(state.layers.link);
    stage.add(state.layers.fx);

    stage.on('click tap', (ev) => {
      if (ev.target === stage) {
        if (state.linkingFrom) stopLinking(true);
        else deselectNode();
      }
    });
    stage.on('mousemove', () => {
      if (state.linkingFrom) updateTempArrow();
    });
    stage.on('contextmenu', (ev) => {
      ev.evt.preventDefault();
      hideContextMenu();
    });

    const wrap = $('#canvasWrap');
    wrap.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const pointer = stage.getPointerPosition() || { x: stage.width() / 2, y: stage.height() / 2 };
      zoomStage(ev.deltaY < 0 ? 1.08 : 0.92, pointer);
    }, { passive: false });

    wrap.addEventListener('dragenter', (ev) => {
      if (!state.dragType) return;
      ev.preventDefault();
      state.dragDepth++;
      showDropOverlay();
    });
    wrap.addEventListener('dragover', (ev) => {
      if (!state.dragType) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      showDropOverlay();
    });
    wrap.addEventListener('dragleave', (ev) => {
      if (!state.dragType) return;
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (state.dragDepth === 0) hideDropOverlay();
    });
    wrap.addEventListener('drop', (ev) => {
      ev.preventDefault();
      state.dragDepth = 0;
      hideDropOverlay();
      const type = ev.dataTransfer.getData('application/x-infra-node') || ev.dataTransfer.getData('text/plain');
      if (!type || !D.COMPONENT_BY_TYPE[type]) return;
      const rect = wrap.getBoundingClientRect();
      const pos = {
        x: (ev.clientX - rect.left - stage.x()) / stage.scaleX(),
        y: (ev.clientY - rect.top - stage.y()) / stage.scaleY(),
      };
      addNodeAt(type, pos.x, pos.y);
    });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => resizeCanvas());
      ro.observe(wrap);
    } else {
      window.addEventListener('resize', resizeCanvas);
    }

    animate();
  }

  function showDropOverlay() {
    const el = $('#dropOverlay');
    if (el) el.classList.remove('hidden');
    $('#canvasWrap').classList.add('dragging');
  }

  function hideDropOverlay() {
    const el = $('#dropOverlay');
    if (el) el.classList.add('hidden');
    $('#canvasWrap').classList.remove('dragging');
  }

  function resizeCanvas() {
    const host = $('#canvasHost');
    if (!state.stage) return;
    const w = Math.max(320, host.clientWidth);
    const h = Math.max(240, host.clientHeight);
    state.stage.width(w);
    state.stage.height(h);
    if (!state.fitDone) {
      fitGraph();
      state.fitDone = true;
    } else if (!state.userZoomed) {
      fitGraph();
    }
  }

  function iconDef(name) {
    if (!window.lucide || !window.lucide.icons) return null;
    return window.lucide.icons[toPascal(name)] || null;
  }

  /**
   * Convert a Lucide SVG definition into Konva vector shapes. This is the
   * canvas equivalent of the DOM <i data-lucide> icons, so the board uses
   * real line icons rather than emoji.
   */
  function createLucideIcon(name, size, color, strokeWidth) {
    const def = iconDef(name);
    const host = new Konva.Group({ listening: false });
    if (!def) {
      const ring = new Konva.Circle({ x: 0, y: 0, radius: size * 0.34, stroke: color, strokeWidth: 1.5 });
      const slash = new Konva.Line({ points: [-size * 0.22, size * 0.22, size * 0.22, -size * 0.22], stroke: color, strokeWidth: 1.5 });
      host.add(ring, slash);
      return host;
    }
    const inner = new Konva.Group({ x: -size / 2, y: -size / 2, scaleX: size / 24, scaleY: size / 24, listening: false });
    const baseStroke = strokeWidth == null ? 2 : strokeWidth;
    const shapes = [];
    const common = { stroke: color, strokeWidth: baseStroke, fillEnabled: false, lineCap: 'round', lineJoin: 'round', listening: false };
    for (const child of (def[2] || [])) {
      const [tag, rawAttrs] = child;
      const a = rawAttrs || {};
      const n = (v) => (v == null ? 0 : parseFloat(v));
      let shape = null;
      if (tag === 'path') {
        shape = new Konva.Path(Object.assign({ data: a.d || '' }, common));
      } else if (tag === 'rect') {
        shape = new Konva.Rect(Object.assign({
          x: n(a.x), y: n(a.y), width: n(a.width), height: n(a.height),
          cornerRadius: n(a.rx) || n(a.ry) || 0,
        }, common));
      } else if (tag === 'circle') {
        shape = new Konva.Circle(Object.assign({ x: n(a.cx), y: n(a.cy), radius: n(a.r) }, common));
      } else if (tag === 'ellipse') {
        shape = new Konva.Ellipse(Object.assign({ x: n(a.cx), y: n(a.cy), radiusX: n(a.rx), radiusY: n(a.ry) }, common));
      } else if (tag === 'line') {
        shape = new Konva.Line(Object.assign({ points: [n(a.x1), n(a.y1), n(a.x2), n(a.y2)] }, common));
      } else if (tag === 'polyline' || tag === 'polygon') {
        const nums = String(a.points || '').trim().split(/[\s,]+/).map(Number).filter((x) => !Number.isNaN(x));
        shape = new Konva.Line(Object.assign({ points: nums, closed: tag === 'polygon' }, common));
      }
      if (shape) {
        shape.listening(false);
        inner.add(shape);
        shapes.push(shape);
      }
    }
    host.add(inner);
    host._shapes = shapes;
    return host;
  }

  function setIconColor(group, color) {
    if (!group || !group._shapes) return;
    for (const s of group._shapes) s.stroke(color);
  }

  function nodeAnchor(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tx = Math.abs(ux) > 1e-6 ? HALF_W / Math.abs(ux) : 10000;
    const ty = Math.abs(uy) > 1e-6 ? HALF_H / Math.abs(uy) : 10000;
    const t = Math.min(tx, ty);
    return [from.x + ux * t, from.y + uy * t, to.x - ux * t, to.y - uy * t];
  }

  function renderGraph() {
    const e = state.engine;
    const stage = state.stage;
    if (!e || !stage) return;
    state.layers.edge.destroyChildren();
    if (state.layers.traffic) state.layers.traffic.destroyChildren();
    state.layers.node.destroyChildren();
    state.layers.fx.destroyChildren();
    state.nodeGroups.clear();
    state.edgeShapes.clear();
    state.particles.clear();
    const reach = e.reachableFromInternet();
    const idle = new Set(e.idleNodeIds || []);

    for (const edge of e.edges.values()) {
      const from = e.nodes.get(edge.from);
      const to = e.nodes.get(edge.to);
      if (!from || !to) continue;
      const pts = nodeAnchor(from, to);
      const arrow = new Konva.Arrow({
        points: pts, stroke: '#334155', strokeWidth: 1.8, opacity: 0.45,
        pointerLength: 7, pointerWidth: 7, dash: [9, 6], hitStrokeWidth: 14,
        lineCap: 'round', lineJoin: 'round', shadowColor: '#22d3ee', shadowBlur: 0,
      });
      arrow._edge = edge;
      arrow.on('contextmenu', (ev) => {
        ev.evt.preventDefault();
        ev.cancelBubble = true;
        showEdgeMenu(ev, edge);
      });
      arrow.on('click tap', (ev) => {
        ev.cancelBubble = true;
        showEdgeMenu(ev, edge);
      });
      state.layers.edge.add(arrow);
      state.edgeShapes.set(edge.key, arrow);
    }

    for (const node of e.nodes.values()) {
      const group = buildNodeGroup(node, e, reach, idle);
      state.layers.node.add(group);
      state.nodeGroups.set(node.id, group);
      if (group._spawn) animateSpawn(group);
    }
    updateGraphVisuals();
  }

  function animateSpawn(group) {
    if (!group) return;
    group.scale({ x: 0.72, y: 0.72 });
    group.opacity(0);
    new Konva.Tween({
      node: group, duration: 0.34, scaleX: 1, scaleY: 1, opacity: 1,
      easing: Konva.Easings.BackEaseOut,
    }).play();
    const burst = new Konva.Circle({ x: 0, y: 0, radius: 18, stroke: '#4ef0b4', strokeWidth: 1.6, opacity: 0.65, listening: false });
    group.add(burst);
    new Konva.Tween({
      node: burst, duration: 0.6, radius: 96, opacity: 0,
      easing: Konva.Easings.EaseOut, onFinish: () => burst.destroy(),
    }).play();
  }

  function buildNodeGroup(node, e, reach, idle) {
    const group = new Konva.Group({
      x: node.x, y: node.y, draggable: true, name: 'node',
      dragDistance: 4,
    });
    group._node = node;
    group._refs = {};
    const isIdle = idle.has(node.id);

    const glow = new Konva.Rect({
      x: -HALF_W - 4, y: -HALF_H - 4, width: NODE_W + 8, height: NODE_H + 8,
      cornerRadius: 15, stroke: '#4ef0b4', strokeWidth: 3, opacity: 0, listening: false,
      shadowColor: '#4ef0b4', shadowBlur: 18,
    });
    const body = new Konva.Rect({
      x: -HALF_W, y: -HALF_H, width: NODE_W, height: NODE_H, cornerRadius: 12,
      fillLinearGradientStartPoint: { x: 0, y: -HALF_H },
      fillLinearGradientEndPoint: { x: 0, y: HALF_H },
      fillLinearGradientColorStops: [0, '#0e1e2c', 0.62, '#0a1622', 1, '#08121c'],
      stroke: '#4ef0b4', strokeWidth: 1.2,
      shadowColor: '#000', shadowBlur: 18, shadowOpacity: 0.28, shadowOffsetY: 7,
    });
    const accent = new Konva.Rect({
      x: -HALF_W, y: -HALF_H + 9, width: 2, height: NODE_H - 18,
      cornerRadius: 1, fill: node.color, opacity: 0.46, listening: false,
    });
    const selRing = new Konva.Rect({
      x: -HALF_W - 5, y: -HALF_H - 5, width: NODE_W + 10, height: NODE_H + 10,
      cornerRadius: 16, stroke: '#4ef0b4', strokeWidth: 1, dash: [5, 5], opacity: 0.85, visible: false, listening: false,
    });
    const iconTile = new Konva.Rect({
      x: -HALF_W + 12, y: -18, width: 36, height: 36, cornerRadius: 9,
      fill: hexToRgba(node.color, 0.075), stroke: hexToRgba(node.color, 0.2), strokeWidth: 1,
    });
    const nodeIcon = createLucideIcon(node.icon, 19, node.color, 2);
    nodeIcon.x(-HALF_W + 30);
    nodeIcon.y(0);

    const label = new Konva.Text({
      x: -HALF_W + 55, y: -29, width: 104, text: truncate(nodeDisplayLabel(node), 27),
      fontSize: nodeDisplayLabel(node).length > 15 ? 9.4 : 10.6,
      fontStyle: 'bold', fontFamily: '"Space Grotesk", "Segoe UI", sans-serif', fill: '#e8f1f8',
      ellipsis: true, wrap: 'none', lineHeight: 1.12,
    });
    const sub = new Konva.Text({
      x: -HALF_W + 55, y: -14, width: 104, text: nodeSubtitle(node, e),
      fontSize: 7.2, fontFamily: '"JetBrains Mono", Consolas, monospace', fill: '#768da3',
      ellipsis: true, wrap: 'none',
    });
    const statusDot = new Konva.Circle({ x: HALF_W - 10, y: -HALF_H + 12, radius: 3.1, fill: '#4ef0b4', stroke: '#04121c', strokeWidth: 1 });
    const loadBg = new Konva.Rect({ x: -HALF_W + 55, y: 9, width: 100, height: 3, cornerRadius: 2, fill: 'rgba(139,166,188,0.13)' });
    const loadFill = new Konva.Rect({ x: -HALF_W + 55, y: 9, width: 0, height: 3, cornerRadius: 2, fill: '#4ef0b4' });
    const healthBg = new Konva.Rect({ x: -HALF_W + 55, y: 15, width: 100, height: 2, cornerRadius: 1, fill: 'rgba(139,166,188,0.1)' });
    const healthFill = new Konva.Rect({ x: -HALF_W + 55, y: 15, width: 100, height: 2, cornerRadius: 1, fill: '#4ef0b4' });
    const idleBadge = new Konva.Group({ x: -HALF_W + 12, y: HALF_H - 18, visible: isIdle && !e.gameOver });
    idleBadge.add(new Konva.Rect({ width: 36, height: 12, cornerRadius: 3, fill: 'rgba(139,166,188,0.12)', stroke: 'rgba(139,166,188,0.22)', strokeWidth: 0.7 }));
    idleBadge.add(new Konva.Text({ x: 4, y: 3, text: 'IDLE', fontSize: 6.2, fontStyle: 'bold', fontFamily: '"JetBrains Mono", monospace', fill: '#91a5b8' }));
    const satBadge = new Konva.Group({ x: -HALF_W + 12, y: HALF_H - 18, visible: false });
    satBadge.add(new Konva.Rect({ width: 39, height: 12, cornerRadius: 3, fill: 'rgba(255,122,122,0.16)', stroke: 'rgba(255,122,122,0.3)', strokeWidth: 0.7 }));
    satBadge.add(new Konva.Text({ x: 4, y: 3, text: 'HOT', fontSize: 6.2, fontStyle: 'bold', fontFamily: '"JetBrains Mono", monospace', fill: '#ffb1b1' }));
    const downOverlay = new Konva.Rect({ x: -HALF_W, y: -HALF_H, width: NODE_W, height: NODE_H, cornerRadius: 12, fill: 'rgba(57,12,18,0.68)', visible: false, listening: false });
    const downText = new Konva.Text({ x: -HALF_W + 55, y: 22, width: 99, text: '', fontSize: 7.2, fontStyle: 'bold', fontFamily: '"JetBrains Mono", monospace', fill: '#ffb1b1', visible: false, listening: false });
    const port = new Konva.Group({ x: HALF_W + 4, y: 0 });
    const portHit = new Konva.Circle({ radius: 11, fill: 'rgba(78,240,180,0.001)' });
    const portDot = new Konva.Circle({ radius: 4.5, fill: '#07121f', stroke: '#4ef0b4', strokeWidth: 1.4 });
    const portPlus = new Konva.Text({ x: -2.5, y: -5, text: '+', fontSize: 7, fill: '#4ef0b4', listening: false });
    port.add(portHit, portDot, portPlus);

    group.add(glow, selRing, body, accent, iconTile, nodeIcon, label, sub, statusDot, loadBg, loadFill, healthBg, healthFill, idleBadge, satBadge, downOverlay, downText, port);
    group._refs = { glow, body, accent, selRing, iconTile, nodeIcon, label, sub, statusDot, loadFill, healthFill, idleBadge, satBadge, downOverlay, downText, port, portDot };

    if (state.spawnNodeId === node.id) {
      state.spawnNodeId = null;
      group._spawn = true;
    }

    group.on('dragstart', () => {
      hideContextMenu();
      group.moveToTop();
      state.userZoomed = true;
      $('#canvasWrap').style.cursor = 'grabbing';
    });
    group.on('dragmove', () => {
      node.x = group.x();
      node.y = group.y();
      for (const arrow of state.edgeShapes.values()) {
        if (arrow._edge && (arrow._edge.from === node.id || arrow._edge.to === node.id)) updateEdgeShape(arrow);
      }
    });
    group.on('dragend', () => {
      $('#canvasWrap').style.cursor = state.spaceHeld ? 'grab' : 'default';
      updateGraphVisuals();
    });
    group.on('mouseenter', () => {
      if (!state.spaceHeld) $('#canvasWrap').style.cursor = state.linkingFrom ? 'crosshair' : 'pointer';
    });
    group.on('mouseleave', () => {
      if (!state.spaceHeld) $('#canvasWrap').style.cursor = 'default';
    });
    group.on('click tap', (ev) => {
      if (ev.target === portHit || ev.target === portDot) return;
      if (state.linkingFrom) {
        finishLinking(node.id);
        return;
      }
      selectNode(node.id);
    });
    port.on('click tap', (ev) => {
      ev.cancelBubble = true;
      if (state.linkingFrom === node.id) {
        stopLinking(true);
      } else {
        startLinking(node.id);
      }
    });
    port.on('mouseenter', () => { $('#canvasWrap').style.cursor = 'crosshair'; });
    port.on('mouseleave', () => { $('#canvasWrap').style.cursor = 'default'; });
    return group;
  }

  function nodeDisplayLabel(node) {
    const map = {
      postgres: 'PostgreSQL DB', mysql: 'MySQL DB', mongodb: 'MongoDB DB',
      replica: 'Read Replica', s3: 'S3 Storage', app_custom: 'Custom Compute',
    };
    return map[node.type] || node.label;
  }

  function nodeSubtitle(node, e) {
    if (node.type === 'replica') return `read · ${fmt(node.baseReadRPS || node.baseCapacityRPS)} RPS`;
    if (node.category === 'database' && node.baseWriteRPS > 0) {
      const s = e.dbStats(node);
      return `${node.config.sharded ? 'SHARDED · ' : ''}${s.shards} shard${s.shards > 1 ? 's' : ''} · ${s.replicas} repl`;
    }
    if (node.category === 'compute') return `${node.config.cores || 0}c / ${node.config.ram || 0}GB`;
    if (node.type === 'internet') return 'SOURCE';
    return node.category.toUpperCase();
  }

  function updateEdgeShape(arrow) {
    const edge = arrow._edge;
    if (!edge) return;
    const from = state.engine.nodes.get(edge.from);
    const to = state.engine.nodes.get(edge.to);
    if (!from || !to) return;
    arrow.points(nodeAnchor(from, to));
  }

  function updateGraphVisuals() {
    const e = state.engine;
    if (!e || !state.stage) return;
    const idle = new Set(e.idleNodeIds || []);
    const attackTarget = e.attackTargetId;
    const mitigation = new Set(e.mitigationNodeIds || []);
    const now = performance.now();
    const highlightIdle = now < state.highlightIdleUntil;
    const selected = state.selectedId;

    for (const [id, group] of state.nodeGroups) {
      const node = e.nodes.get(id);
      if (!node) continue;
      const r = group._refs;
      const down = e.isNodeDown(node);
      const isIdle = idle.has(id);
      let load = node.load || 0;
      let stroke = load > 0.92 ? '#ff7a7a' : load > 0.78 ? '#fb9b5c' : load > 0.55 ? '#f6c85f' : '#4ef0b4';
      if (isIdle) stroke = '#536b80';
      if (down) stroke = '#ff7a7a';
      if (id === attackTarget) stroke = '#ff5b76';
      if (isIdle && highlightIdle) stroke = '#f6c85f';

      r.body.stroke(stroke);
      r.body.strokeWidth(id === attackTarget || load > 0.92 ? 1.9 : 1.15);
      r.body.dash(isIdle ? [6, 5] : []);
      r.accent.fill(down ? '#ff7a7a' : node.color);
      r.iconTile.fill(down ? 'rgba(255,122,122,0.07)' : hexToRgba(node.color, 0.075));
      r.iconTile.stroke(down ? 'rgba(255,122,122,0.24)' : hexToRgba(node.color, 0.2));
      setIconColor(r.nodeIcon, down ? '#ffb1b1' : node.color);
      r.label.fill(down ? '#ffb1b1' : isIdle ? '#94a9bb' : '#e8f1f8');
      r.label.text(truncate(nodeDisplayLabel(node), 27));
      r.label.fontSize(nodeDisplayLabel(node).length > 15 ? 9.4 : 10.6);
      r.sub.text(nodeSubtitle(node, e));
      r.statusDot.fill(down ? '#ff7a7a' : isIdle ? '#536b80' : load > 0.92 ? '#ff7a7a' : load > 0.7 ? '#f6c85f' : '#4ef0b4');
      r.healthFill.width(down ? 0 : 100 * clamp((node.health == null ? 100 : node.health) / 100, 0, 1));
      r.healthFill.fill(down ? '#ff7a7a' : '#4ef0b4');
      r.loadFill.width(100 * clamp(load, 0, 1));
      r.loadFill.fill(load > 0.92 ? '#ff7a7a' : load > 0.78 ? '#fb9b5c' : load > 0.55 ? '#f6c85f' : '#4ef0b4');
      r.idleBadge.visible(isIdle && !e.gameOver);
      r.satBadge.visible(!isIdle && !down && load > 0.92);
      r.downOverlay.visible(down);
      r.downText.visible(down);
      if (down) {
        const remain = Math.max(0, (node.downUntil - e.simTime) / 1000).toFixed(1);
        r.downText.text(`DOWN ${remain}s`);
      }
      r.selRing.visible(selected === id);
      r.glow.opacity(0);
      r.glow.stroke('#4ef0b4');
      if (id === attackTarget) {
        r.glow.stroke('#ff5b76');
        r.glow.opacity(0.32 + 0.28 * (0.5 + 0.5 * Math.sin(now / 180)));
      } else if (mitigation.has(id)) {
        r.glow.stroke('#4ef0b4');
        r.glow.opacity(0.3 + 0.15 * (0.5 + 0.5 * Math.sin(now / 400)));
      } else if (selected === id) {
        r.glow.stroke('#4ef0b4');
        r.glow.opacity(0.22);
      } else if (isIdle && highlightIdle) {
        r.glow.stroke('#f6c85f');
        r.glow.opacity(0.4);
      }
      r.portDot.stroke(id === attackTarget ? '#ff5b76' : '#4ef0b4');
      r.portDot.fill(state.linkingFrom === id ? '#4ef0b4' : '#07121f');
    }

    for (const arrow of state.edgeShapes.values()) {
      const edge = arrow._edge;
      if (!edge) continue;
      const from = e.nodes.get(edge.from);
      const to = e.nodes.get(edge.to);
      if (!from || !to) continue;
      const fromIdle = idle.has(from.id) || idle.has(to.id);
      const down = e.isNodeDown(from) || e.isNodeDown(to);
      const flow = edge.flow || 0;
      const active = flow > 0.5 && !down && !fromIdle;
      let color = active ? '#4ef0b4' : '#3b5165';
      if (down) color = '#ff7a7a';
      else if (fromIdle) color = '#3b5165';
      arrow.stroke(color);
      arrow.opacity(active ? 0.88 : down ? 0.65 : fromIdle ? 0.3 : 0.52);
      arrow.strokeWidth(active ? 2 : 1.35);
      arrow.dash(active ? [9, 7] : [4, 8]);
      arrow.shadowBlur(active ? 12 : 0);
      arrow.shadowColor('#4ef0b4');
      arrow._flow = active ? Math.min(1, flow / 8000) : 0;
      updateEdgeShape(arrow);
    }
    syncParticles();
  }

  function syncParticles() {
    if (!state.layers.traffic) return;
    const activeKeys = new Set();
    for (const [key, arrow] of state.edgeShapes) {
      if (arrow._flow > 0 && arrow._edge) {
        activeKeys.add(key);
        if (!state.particles.has(key)) {
          const group = new Konva.Group({ listening: false });
          const dots = [];
          for (let i = 0; i < 4; i++) {
            const dot = new Konva.Circle({
              radius: i === 0 ? 2.5 : i === 2 ? 1.9 : 1.6,
              fill: i === 1 || i === 3 ? '#4d9cff' : '#4ef0b4',
              shadowColor: i === 1 || i === 3 ? '#4d9cff' : '#4ef0b4',
              shadowBlur: 9, opacity: 0,
            });
            dots.push(dot);
            group.add(dot);
          }
          state.layers.traffic.add(group);
          state.particles.set(key, { group, dots, offsets: [0, 0.24, 0.5, 0.76], seed: Math.random() * 1000 });
        }
        const p = state.particles.get(key);
        p.group.visible(true);
      }
    }
    for (const [key, p] of state.particles) {
      if (!activeKeys.has(key)) p.group.visible(false);
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    const e = state.engine;
    if (!e || !state.stage) return;
    const t = performance.now();
    for (const arrow of state.edgeShapes.values()) {
      if (arrow._flow > 0) arrow.dashOffset(-(t / 26) % 80);
    }
    // Incoming request particles: small dots run from source to handler.
    for (const [key, p] of state.particles) {
      const arrow = state.edgeShapes.get(key);
      if (!arrow || !p.group.visible()) continue;
      const pts = arrow.points();
      const len = Math.max(1, Math.hypot(pts[2] - pts[0], pts[3] - pts[1]));
      const speed = 0.24 + (arrow._flow || 0) * 0.5;
      const base = ((t / 1000 * speed) + p.seed) % 1;
      for (let i = 0; i < p.dots.length; i++) {
        const u = (base + p.offsets[i]) % 1;
        const dot = p.dots[i];
        dot.x(pts[0] + (pts[2] - pts[0]) * u);
        dot.y(pts[1] + (pts[3] - pts[1]) * u);
        dot.opacity(0.18 + 0.72 * Math.sin(Math.PI * u));
      }
    }
    if (state.tempArrow) {
      const glow = 0.55 + 0.2 * Math.sin(t / 250);
      state.tempArrow.opacity(glow);
    }
    // Smoothly interpolate the cost/hr counter (Konva-free RAF counter).
    const target = e.costPerHour || 0;
    state.costShown += (target - state.costShown) * 0.14;
    if (Math.abs(target - state.costShown) < 0.0005) state.costShown = target;
    const costEl = $('#costVal');
    if (costEl) costEl.textContent = money(state.costShown);
  }

  function zoomStage(factor, pointer) {
    if (!state.stage) return;
    const stage = state.stage;
    const oldScale = stage.scaleX();
    const newScale = clamp(oldScale * factor, 0.35, 2.2);
    const p = pointer || { x: stage.width() / 2, y: stage.height() / 2 };
    const mx = (p.x - stage.x()) / oldScale;
    const my = (p.y - stage.y()) / oldScale;
    stage.scale({ x: newScale, y: newScale });
    stage.position({ x: p.x - mx * newScale, y: p.y - my * newScale });
    state.userZoomed = true;
  }

  function fitGraph() {
    const e = state.engine;
    const stage = state.stage;
    if (!e || !stage) return;
    const nodes = Array.from(e.nodes.values());
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map((n) => n.x)) - HALF_W - 40;
    const maxX = Math.max(...nodes.map((n) => n.x)) + HALF_W + 40;
    const minY = Math.min(...nodes.map((n) => n.y)) - HALF_H - 50;
    const maxY = Math.max(...nodes.map((n) => n.y)) + HALF_H + 40;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const scale = clamp(Math.min((stage.width() - 40) / bw, (stage.height() - 70) / bh), 0.4, 1.25);
    stage.scale({ x: scale, y: scale });
    stage.position({
      x: (stage.width() - bw * scale) / 2 - minX * scale,
      y: (stage.height() - bh * scale) / 2 - minY * scale + 10,
    });
    state.userZoomed = false;
  }

  /* ------------------------------------------------------------------ */
  /* NODE MUTATIONS                                                      */
  /* ------------------------------------------------------------------ */
  function addNodeAt(type, x, y) {
    const e = state.engine;
    if (!e) return;
    if (type === 'internet' && e.nodes.has('internet')) {
      toast({ tone: 'warn', icon: 'globe', title: 'Single source', message: 'There can only be one Internet source node.' });
      selectNode('internet');
      return;
    }
    const jitter = (Math.random() - 0.5) * 26;
    const node = e.addNode(type, Math.round(x + jitter), Math.round(y + jitter));
    let auto = '';
    if (['network', 'devops', 'security'].includes(node.category) && node.type !== 'internet') {
      const c = e.connect('internet', node.id);
      if (c.ok) auto = ' Auto-attached to Internet as a control/edge sidecar.';
    }
    e.recalculateCost();
    e.updateDerived();
    state.selectedId = node.id;
    state.spawnNodeId = node.id;
    renderGraph();
    renderAll(true);
    toast({
      tone: 'info', icon: node.icon, title: `${node.label} deployed`,
      message: `${money(node.currentCost, 2)}/hr · ${node.category === 'compute' ? fmt(node.baseCapacityRPS) + ' RPS capacity' : 'added to graph'}.${auto}`,
    });
    return node;
  }

  function deployForRunbook(actionId) {
    const e = state.engine;
    if (!e) return;
    const pos = nextFreePosition();
    if (actionId === 'runbook-add-lb') {
      addNodeAt('lb', pos.x, pos.y);
    } else if (actionId === 'runbook-add-queue') {
      const q = addNodeAt('kafka', pos.x, pos.y);
      if (q) {
        e.connect('internet', q.id);
        e.updateDerived();
        renderGraph();
        renderAll(true);
      }
    } else if (actionId === 'runbook-add-replica') {
      const db = Array.from(e.nodes.values()).find((n) => n.category === 'database' && n.baseWriteRPS > 0 && !e.isNodeDown(n));
      if (db) addReadReplicaFor(db);
      else toast({ tone: 'warn', icon: 'database', title: 'No primary to replicate', message: 'Deploy a primary database first.' });
    } else if (actionId === 'runbook-add-app') {
      const app = addNodeAt('app_4c', pos.x, pos.y);
      if (app) {
        const reach = e.reachableFromInternet();
        const dbs = Array.from(e.nodes.values()).filter((n) => n.category === 'database' && n.baseWriteRPS > 0 && reach.has(n.id) && !e.isNodeDown(n));
        e.connect('internet', app.id);
        for (const db of dbs) e.connect(app.id, db.id);
        e.updateDerived();
        renderGraph();
        renderAll(true);
        toast({ tone: 'good', icon: 'server', title: 'Spare app online', message: `App 4c connected to ${dbs.length} database${dbs.length === 1 ? '' : 's'}; it joins the failover pool immediately.` });
      }
    }
    renderRunbook(true);
  }

  function nextFreePosition() {
    const stage = state.stage;
    const e = state.engine;
    const center = {
      x: (stage.width() / 2 - stage.x()) / stage.scaleX(),
      y: (stage.height() / 2 - stage.y()) / stage.scaleY(),
    };
    let px = center.x, py = center.y;
    let guard = 0;
    while (guard++ < 50) {
      const clash = Array.from(e.nodes.values()).some((n) => Math.abs(n.x - px) < 150 && Math.abs(n.y - py) < 80);
      if (!clash) break;
      px += 42;
      py += 28;
      if (px > center.x + 380) { px = center.x - 200; py += 70; }
    }
    return { x: px, y: py };
  }

  function selectNode(id) {
    if (!state.engine || !state.engine.nodes.has(id)) return;
    state.selectedId = id;
    state.configSig = '';
    renderConfigPanel(true);
    updateGraphVisuals();
  }

  function deselectNode() {
    state.selectedId = null;
    state.configSig = '';
    renderConfigPanel(true);
    updateGraphVisuals();
  }

  function startLinking(fromId) {
    const e = state.engine;
    if (!e || !e.nodes.has(fromId) || e.gameOver) return;
    state.linkingFrom = fromId;
    state.selectedId = fromId;
    const node = e.nodes.get(fromId);
    $('#linkBanner').classList.remove('hidden');
    $('#linkBanner').innerHTML = `${icon('spline')}<span>Link from <b>${esc(node.label)}</b> · click a target · <span class="kbd">Esc</span> cancel</span>`;
    $('#hintTooltip').classList.add('hidden');
    const stage = state.stage;
    const pointer = stage.getPointerPosition() || { x: stage.width() / 2, y: stage.height() / 2 };
    const pos = { x: (pointer.x - stage.x()) / stage.scaleX(), y: (pointer.y - stage.y()) / stage.scaleY() };
    if (state.tempArrow) state.tempArrow.destroy();
    state.tempArrow = new Konva.Arrow({
      points: [node.x, node.y, pos.x, pos.y], stroke: '#22d3ee', strokeWidth: 2,
      pointerLength: 8, pointerWidth: 8, dash: [7, 5], opacity: 0.7,
    });
    state.layers.link.add(state.tempArrow);
    $('#canvasWrap').style.cursor = 'crosshair';
    renderConfigPanel(true);
    updateGraphVisuals();
  }

  function stopLinking(silent) {
    state.linkingFrom = null;
    $('#linkBanner').classList.add('hidden');
    if (state.tempArrow) {
      state.tempArrow.destroy();
      state.tempArrow = null;
    }
    $('#canvasWrap').style.cursor = 'default';
    renderHint();
    updateGraphVisuals();
    if (!silent) renderConfigPanel(true);
  }

  function updateTempArrow() {
    const e = state.engine;
    if (!state.linkingFrom || !state.tempArrow || !state.stage) return;
    const node = e.nodes.get(state.linkingFrom);
    if (!node) return;
    const pointer = state.stage.getPointerPosition();
    if (!pointer) return;
    const pos = {
      x: (pointer.x - state.stage.x()) / state.stage.scaleX(),
      y: (pointer.y - state.stage.y()) / state.stage.scaleY(),
    };
    state.tempArrow.points([node.x, node.y, pos.x, pos.y]);
  }

  function finishLinking(toId) {
    const e = state.engine;
    const fromId = state.linkingFrom;
    if (!fromId || !toId) return;
    const res = e.connect(fromId, toId);
    if (res.ok) {
      const from = e.nodes.get(fromId);
      const to = e.nodes.get(toId);
      e.updateDerived();
      stopLinking(true);
      state.selectedId = toId;
      renderGraph();
      renderAll(true);
      toast({ tone: 'good', icon: 'link-2', title: 'Connected', message: `${from.label} → ${to.label}. Traffic will use this path on the next tick.` });
    } else {
      toast({ tone: 'warn', icon: 'circle-x', title: 'Cannot connect', message: res.reason });
    }
  }

  function showEdgeMenu(ev, edge) {
    const menu = $('#contextMenu');
    const from = state.engine.nodes.get(edge.from);
    const to = state.engine.nodes.get(edge.to);
    state.contextEdgeKey = edge.key;
    menu.innerHTML = `
      <div class="cm-head">Connection</div>
      <div style="padding:2px 7px 5px;color:#cbd5e1;font-size:9px">${esc(from ? from.label : edge.from)} → ${esc(to ? to.label : edge.to)}</div>
      <button data-edge-action="delete">${icon('trash-2')} Delete connection</button>`;
    menu.classList.remove('hidden');
    const x = Math.min(ev.evt.clientX, window.innerWidth - 175);
    const y = Math.min(ev.evt.clientY, window.innerHeight - 90);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    refreshIcons();
  }

  function hideContextMenu() {
    const menu = $('#contextMenu');
    if (menu) menu.classList.add('hidden');
    state.contextEdgeKey = null;
  }

  function spawnSparks(nodeId, color) {
    const e = state.engine;
    const group = state.nodeGroups.get(nodeId);
    if (!e || !group || !state.layers.fx) return;
    const node = e.nodes.get(nodeId);
    if (!node) return;
    for (let i = 0; i < 12; i++) {
      const c = new Konva.Circle({
        x: node.x + (Math.random() - 0.5) * 40,
        y: node.y + (Math.random() - 0.5) * 24,
        radius: 1 + Math.random() * 2.4,
        fill: color, opacity: 0.95, listening: false,
      });
      state.layers.fx.add(c);
      new Konva.Tween({
        node: c, duration: 0.7 + Math.random() * 0.35,
        x: node.x + (Math.random() - 0.5) * 170,
        y: node.y + (Math.random() - 0.5) * 120,
        opacity: 0, radius: 0.3, easing: Konva.Easings.EaseOut,
        onFinish: () => c.destroy(),
      }).play();
    }
    flashWave();
  }

  function flashWave() {
    const flash = $('#waveFlash');
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
  }

  /* ------------------------------------------------------------------ */
  /* CONFIG PANEL                                                        */
  /* ------------------------------------------------------------------ */
  function configSignature(n) {
    const e = state.engine;
    if (!n) return 'none';
    return [
      n.id, n.type, n.config.shards, n.config.replicas, n.config.cores, n.config.ram,
      n.config.sharded, !!n.failure, e.edgesFor(n.id).length, e.idleNodeIds.includes(n.id),
      state.linkingFrom === n.id,
    ].join('|');
  }

  function statusOf(n) {
    const e = state.engine;
    if (!n) return { label: 'unknown', cls: 'dim' };
    if (e.isNodeDown(n)) return { label: 'DOWN', cls: 'bad' };
    if (e.idleNodeIds.includes(n.id)) return { label: 'IDLE', cls: 'warn' };
    if (n.load > 0.92) return { label: 'SATURATED', cls: 'bad' };
    if (n.load > 0.7) return { label: 'HOT', cls: 'warn' };
    return { label: 'HEALTHY', cls: 'ok' };
  }

  function capacityText(n, e) {
    if (n.type === 'internet' || n.baseCapacityRPS >= 1e8) return '∞ control';
    if (n.category === 'database' && n.baseWriteRPS > 0) {
      const s = e.dbStats(n);
      return `${fmt(s.readRPS)}r / ${fmt(s.writeRPS)}w`;
    }
    return fmt(n.baseCapacityRPS);
  }

  function renderConfigPanel(force) {
    const e = state.engine;
    if (!e) return;
    const n = state.selectedId ? e.nodes.get(state.selectedId) : null;
    if (!n && state.selectedId) state.selectedId = null;
    const sig = configSignature(n);
    if (!force && sig === state.configSig) {
      updateConfigLive();
      return;
    }
    state.configSig = sig;
    const card = $('#configPanel');
    if (!n) {
      const hot = e.getPressureNodes();
      card.innerHTML = `
        <div class="card-head">
          <i class="ch-icon" data-lucide="settings-2"></i>
          <div class="ch-title">Node Inspector</div>
          <div class="ch-right"><span class="badge dim">${icon('mouse-pointer')} select</span></div>
        </div>
        <div class="card-body">
          <div class="empty-note" style="color:#9fb3c9">Click a node on the canvas (or drop one from the palette) to configure it. Every node has a cost, a capacity and a failure mode.</div>
          <div class="stat-grid" style="margin-top:8px">
            <div class="stat"><div class="s-label">Nodes</div><div class="s-value">${e.nodes.size}</div></div>
            <div class="stat"><div class="s-label">Wires</div><div class="s-value">${e.edges.size}</div></div>
            <div class="stat"><div class="s-label">Cost/hr</div><div class="s-value">${money(e.costPerHour)}</div></div>
            <div class="stat"><div class="s-label">Idle $/hr</div><div class="s-value" style="color:${e.idleCostPerHour > 0 ? '#fbbf24' : '#34d399'}">${money(e.idleCostPerHour)}</div></div>
          </div>
          ${hot.length ? `<div class="pressure-note"><b>${hot.length} node${hot.length > 1 ? 's' : ''} under pressure.</b> Open pressure controls to scale down or take down deliberately.<div class="btn-row"><button class="btn mini danger" data-action="open-pressure">${icon('arrow-down-to-line')} Relieve pressure</button></div></div>` : ''}
          <div class="tiny" style="margin-top:7px">Del key removes a selected node. Right-click a wire deletes it. Space+drag pans; wheel zooms.</div>
        </div>`;
      refreshIcons();
      return;
    }

    const st = statusOf(n);
    const idle = e.idleNodeIds.includes(n.id);
    const down = e.isNodeDown(n);
    const load = Math.round((n.load || 0) * 100);
    const health = down ? 0 : (n.health == null ? 100 : n.health);
    const edges = e.edgesFor(n.id);
    const capacity = capacityText(n, e);
    const canDelete = n.type !== 'internet';
    let extra = '';

    if (n.category === 'database' && n.baseWriteRPS > 0) {
      const s = e.dbStats(n);
      extra = `
        <div class="field">
          <div class="field-head"><span class="field-label">Shards · 1–16</span><span class="field-val" id="cfgShardVal">${s.shards}</span></div>
          <input type="range" id="dbShardsRange" min="1" max="16" step="1" value="${s.shards}" />
          <div style="display:flex;gap:4px;align-items:center;margin-top:4px">
            <input type="number" id="dbShardsNum" class="inline-input" min="1" max="16" value="${s.shards}" />
            <span class="tiny">shards</span>
            <span class="tiny" style="margin-left:auto">write × shards</span>
          </div>
        </div>
        <div class="field">
          <div class="field-head"><span class="field-label">Replicas / shard · 0–5</span><span class="field-val" id="cfgReplicaVal">${s.replicas}</span></div>
          <input type="range" id="dbReplicasRange" min="0" max="5" step="1" value="${s.replicas}" />
          <div style="display:flex;gap:4px;align-items:center;margin-top:4px">
            <input type="number" id="dbReplicasNum" class="inline-input" min="0" max="5" value="${s.replicas}" />
            <span class="tiny">replicas</span>
            ${s.replicationLag ? `<span class="badge warn" style="margin-left:auto">${icon('timer')} lag risk</span>` : ''}
          </div>
        </div>
        <div class="teach-box" id="dbProjection">${dbProjection(s)}</div>
        <div class="btn-row">
          <button class="btn mini" data-action="add-replica">${icon('copy')} Add Read Replica</button>
          <button class="btn mini" data-action="convert-sharded">${icon('layers')} Convert to Sharded</button>
        </div>
        ${n.config.sharded ? `<div class="tiny" style="margin-top:4px;color:#93c5fd">${icon('layers')} Sharded cluster badge active.</div>` : ''}`;
    } else if (n.category === 'compute') {
      if (n.custom) {
        extra = `
          <div class="field">
            <div class="field-head"><span class="field-label">vCPU · 1–128</span><span class="field-val" id="cfgCoresVal">${n.config.cores}</span></div>
            <input type="range" id="customCoresRange" min="1" max="128" step="1" value="${n.config.cores}" />
            <input type="number" id="customCoresNum" class="inline-input" min="1" max="128" value="${n.config.cores}" style="margin-top:4px" />
          </div>
          <div class="field">
            <div class="field-head"><span class="field-label">RAM · 1–512GB</span><span class="field-val" id="cfgRamVal">${n.config.ram}</span></div>
            <input type="range" id="customRamRange" min="1" max="512" step="1" value="${n.config.ram}" />
            <input type="number" id="customRamNum" class="inline-input" min="1" max="512" value="${n.config.ram}" style="margin-top:4px" />
          </div>
          <div class="teach-box" id="computeProjection">${computeProjection(n)}</div>`;
      } else {
        extra = `<div class="teach-box">Tiered app server. Capacity scales linearly with vCPU. Use <b>Scale down</b> to step the tier down and cut cost immediately.</div>`;
      }
    } else if (n.category === 'queue') {
      extra = `<div class="teach-box">Buffer capacity <b>${fmt(n.bufferRPS)} msg/s</b> · max backlog ${n.maxBacklogSeconds}s. Current backlog: <b id="cfgBacklog">${Math.round(n.backlog || 0)}</b> messages. When the DB is down, this queue absorbs overflow instead of dropping it.</div>`;
    } else if (n.category === 'network' || n.category === 'security' || n.category === 'devops' || n.category === 'storage') {
      const mitigates = (n.mitigations || []).map((id) => D.ATTACK_BY_ID[id] ? D.ATTACK_BY_ID[id].name : null).filter(Boolean);
      extra = mitigates.length ? `<div class="tiny" style="margin-top:6px">Hardens against: ${mitigates.slice(0, 6).map((m) => `<span class="badge info" style="margin:1px 2px 0 0">${esc(m)}</span>`).join('')}</div>` : '';
      if (n.category === 'queue') extra += '';
    }

    const mitText = n.mitigations && n.mitigations.length ? ` · mitigates ${n.mitigations.length} attack type(s)` : '';
    card.innerHTML = `
      <div class="card-head">
        <i class="ch-icon" data-lucide="settings-2"></i>
        <div class="ch-title">Node Inspector</div>
        <div class="ch-right">
          <span class="badge ${st.cls}" id="cfgStatus">${icon(st.cls === 'ok' ? 'circle-check' : st.cls === 'bad' ? 'triangle-alert' : 'circle-dot')} ${st.label}</span>
          ${canDelete ? `<button class="tool-btn" data-action="delete-node" title="Take down node" style="width:22px;height:22px">${icon('trash-2')}</button>` : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="node-title-row">
          <div class="node-avatar" style="--node-color:${n.color}">${icon(n.icon)}</div>
          <div style="min-width:0">
            <div class="node-name">${esc(n.label)}</div>
            <div class="node-type">${esc(n.type)} · ${esc(n.id)}${n.config.sharded ? ' · SHARDED' : ''}</div>
          </div>
        </div>
        <div class="stat-grid">
          <div class="stat"><div class="s-label">Cost / hr</div><div class="s-value" id="cfgCostVal">${money(e.getNodeCost(n), 2)}</div></div>
          <div class="stat"><div class="s-label">Capacity</div><div class="s-value" id="cfgCapacityVal">${capacity}</div></div>
          <div class="stat"><div class="s-label">Latency</div><div class="s-value">${fmt(n.latencyMs)}ms</div></div>
          <div class="stat"><div class="s-label">Load</div><div class="s-value" id="cfgLoadVal">${load}%</div></div>
        </div>
        <div class="bar-row"><span class="br-label">Health</span><div class="bar"><i id="cfgHealthBar" style="width:${health}%;--bar-color:${health > 60 ? '#34d399' : '#f87171'}"></i></div><span class="br-val">${health}%</span></div>
        <div class="bar-row"><span class="br-label">Util</span><div class="bar"><i id="cfgLoadBar" style="width:${Math.min(100, load)}%;--bar-color:${load > 92 ? '#f87171' : load > 70 ? '#fbbf24' : '#22d3ee'}"></i></div><span class="br-val">${load}%</span></div>
        <div class="tiny" style="margin-top:6px">${esc(n.description || '')}${esc(mitText)}</div>
        ${idle ? `<div class="pressure-note" style="border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.06);color:#fde68a;margin-top:6px">IDLE: this node charges <b>${money(e.getNodeCost(n), 2)}/hr</b> but receives zero traffic. Connect it or take it down.</div>` : ''}
        ${down ? `<div class="pressure-note" style="border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.07);color:#fecaca;margin-top:6px">DOWN · recovering in ${Math.max(0, (n.downUntil - e.simTime) / 1000).toFixed(1)}s · ${esc(n.failure ? n.failure.name : 'failure')}${n.failureName ? ' · ' + esc(n.failureName) : ''}</div>` : ''}
        ${(n.load || 0) > 0.8 ? `<div class="pressure-note">UNDER PRESSURE (${Math.round(n.load * 100)}%). Scale down to reduce cost, or take it down deliberately — both remove capacity.</div>` : ''}
        ${extra}
        <div class="field">
          <div class="field-head"><span class="field-label">Connections (${edges.length})</span><span class="field-val">${e.reachableFromInternet().has(n.id) ? 'reachable' : 'not reachable'}</span></div>
          <div class="edge-list">
            ${edges.length ? edges.map((edge) => {
              const other = edge.from === n.id ? e.nodes.get(edge.to) : e.nodes.get(edge.from);
              const dir = edge.from === n.id ? '→' : '←';
              return `<div class="edge-row"><span>${dir}</span><span class="er-name">${esc(other ? other.label : '?')}</span><button data-action="delete-edge" data-edge-key="${esc(edge.key)}" title="Delete connection">${icon('x')}</button></div>`;
            }).join('') : '<div class="tiny">No connections. Drag from the port on the right side of a node, or click Connect below.</div>'}
          </div>
        </div>
        <div class="btn-row">
          <button class="btn" data-action="connect-node">${icon('spline')} Connect from here</button>
          <button class="btn" data-action="scale-down">${icon('arrow-down-to-line')} Scale down</button>
        </div>
        ${canDelete ? `<div class="danger-zone">
          <div class="dz-label">Danger zone — cost vs capacity</div>
          <div class="btn-row" style="margin-top:0">
            <button class="btn danger" data-action="take-down">${icon('power')} Take down node</button>
          </div>
          <div class="tiny" style="margin-top:4px">Removing ${esc(n.label)} saves <b>${money(e.getNodeCost(n), 2)}/hr</b>, but all of its capacity and wires disappear.</div>
        </div>` : `<div class="tiny" style="margin-top:7px">Source node — cannot be taken down.</div>`}
      </div>`;
    refreshIcons();
  }

  function dbProjection(s) {
    return `This DB can serve <b>${fmt(s.writeRPS)} writes/s</b>, <b>${fmt(s.readRPS)} reads/s</b> at <b>${money(s.costPerHour)}/hr</b>.` +
      (s.replicationLag ? ' Replication lag risk: >3 replicas per shard.' : '');
  }

  function computeProjection(n) {
    return `This server can serve <b>${fmt(n.baseCapacityRPS)} RPS</b> at <b>${money(n.currentCost || n.costPerHour)}/hr</b> (${n.config.cores} vCPU / ${n.config.ram}GB).`;
  }

  function updateConfigLive() {
    const e = state.engine;
    if (!e) return;
    const n = state.selectedId ? e.nodes.get(state.selectedId) : null;
    if (!n) return;
    const down = e.isNodeDown(n);
    const load = Math.round((n.load || 0) * 100);
    const health = down ? 0 : 100;
    if ($('#cfgCostVal')) $('#cfgCostVal').textContent = money(e.getNodeCost(n), 2);
    if ($('#cfgCapacityVal')) $('#cfgCapacityVal').textContent = capacityText(n, e);
    if ($('#cfgLoadVal')) $('#cfgLoadVal').textContent = load + '%';
    if ($('#cfgLoadBar')) {
      $('#cfgLoadBar').style.width = Math.min(100, load) + '%';
      $('#cfgLoadBar').style.setProperty('--bar-color', load > 92 ? '#f87171' : load > 70 ? '#fbbf24' : '#22d3ee');
    }
    if ($('#cfgHealthBar')) $('#cfgHealthBar').style.width = health + '%';
    if ($('#cfgBacklog')) $('#cfgBacklog').textContent = Math.round(n.backlog || 0);
    if ($('#dbProjection')) $('#dbProjection').innerHTML = dbProjection(e.dbStats(n));
    if ($('#computeProjection')) $('#computeProjection').innerHTML = computeProjection(n);
  }

  function syncConfigSig() {
    const n = state.selectedId ? state.engine.nodes.get(state.selectedId) : null;
    state.configSig = configSignature(n);
  }

  /* config input handling */
  function onConfigInput(ev) {
    const e = state.engine;
    const n = state.selectedId ? e.nodes.get(state.selectedId) : null;
    if (!n) return;
    const t = ev.target;
    if (t.id === 'dbShardsRange' || t.id === 'dbShardsNum') {
      const v = clamp(parseInt(t.value, 10) || 1, 1, 16);
      n.config.shards = v;
      if ($('#dbShardsRange')) $('#dbShardsRange').value = v;
      if ($('#dbShardsNum')) $('#dbShardsNum').value = v;
      if ($('#cfgShardVal')) $('#cfgShardVal').textContent = v;
      e.recalculateCost();
      e.updateDerived();
      syncConfigSig();
      updateConfigLive();
      renderMetrics();
      renderWarnings();
    } else if (t.id === 'dbReplicasRange' || t.id === 'dbReplicasNum') {
      const v = clamp(parseInt(t.value, 10) || 0, 0, 5);
      n.config.replicas = v;
      if ($('#dbReplicasRange')) $('#dbReplicasRange').value = v;
      if ($('#dbReplicasNum')) $('#dbReplicasNum').value = v;
      if ($('#cfgReplicaVal')) $('#cfgReplicaVal').textContent = v;
      e.recalculateCost();
      e.updateDerived();
      syncConfigSig();
      updateConfigLive();
      renderMetrics();
      renderWarnings();
    } else if (t.id === 'customCoresRange' || t.id === 'customCoresNum') {
      const v = clamp(parseInt(t.value, 10) || 1, 1, 128);
      n.config.cores = v;
      if ($('#customCoresRange')) $('#customCoresRange').value = v;
      if ($('#customCoresNum')) $('#customCoresNum').value = v;
      if ($('#cfgCoresVal')) $('#cfgCoresVal').textContent = v;
      e.applyCustom(n);
      e.recalculateCost();
      e.updateDerived();
      syncConfigSig();
      updateConfigLive();
      renderMetrics();
      renderWarnings();
      updateGraphVisuals();
    } else if (t.id === 'customRamRange' || t.id === 'customRamNum') {
      const v = clamp(parseInt(t.value, 10) || 1, 1, 512);
      n.config.ram = v;
      if ($('#customRamRange')) $('#customRamRange').value = v;
      if ($('#customRamNum')) $('#customRamNum').value = v;
      if ($('#cfgRamVal')) $('#cfgRamVal').textContent = v;
      e.applyCustom(n);
      e.recalculateCost();
      e.updateDerived();
      syncConfigSig();
      updateConfigLive();
      renderMetrics();
      renderWarnings();
      updateGraphVisuals();
    }
  }

  function findNearbyPosition(anchor) {
    const stage = state.stage;
    const e = state.engine;
    if (!stage) return { x: anchor.x + 180, y: anchor.y + 100 };
    const s = stage.scaleX();
    const bounds = {
      minX: (70 - stage.x()) / s,
      maxX: (stage.width() - 70 - stage.x()) / s,
      minY: (80 - stage.y()) / s,
      maxY: (stage.height() - 70 - stage.y()) / s,
    };
    const candidates = [
      { x: anchor.x + 200, y: anchor.y },
      { x: anchor.x, y: anchor.y + 130 },
      { x: anchor.x - 200, y: anchor.y },
      { x: anchor.x, y: anchor.y - 130 },
      { x: anchor.x + 160, y: anchor.y + 120 },
      { x: anchor.x - 160, y: anchor.y + 120 },
    ];
    const others = Array.from(e.nodes.values()).filter((n) => n.id !== anchor.id);
    for (const c of candidates) {
      const inBounds = c.x >= bounds.minX && c.x <= bounds.maxX && c.y >= bounds.minY && c.y <= bounds.maxY;
      const clash = others.some((n) => Math.abs(n.x - c.x) < NODE_W + 24 && Math.abs(n.y - c.y) < NODE_H + 20);
      if (inBounds && !clash) return c;
    }
    return {
      x: clamp(anchor.x, bounds.minX, bounds.maxX),
      y: clamp(anchor.y + 130, bounds.minY, bounds.maxY),
    };
  }

  function addReadReplicaFor(db) {
    const e = state.engine;
    const pos = findNearbyPosition(db);
    const replica = e.addNode('replica', pos.x, pos.y, {
      label: `Read Replica (${db.label})`,
      config: { attachedTo: db.id },
    });
    state.spawnNodeId = replica.id;
    replica.attachedTo = db.id;
    const parents = e.edgesFor(db.id).filter((ed) => ed.to === db.id);
    let connected = 0;
    for (const p of parents) {
      if (e.connect(p.from, replica.id).ok) connected++;
    }
    if (!connected) {
      e.connect('internet', replica.id);
      connected++;
    }
    e.updateDerived();
    renderGraph();
    renderAll(true);
    toast({ tone: 'good', icon: 'copy', title: 'Read replica added', message: `${replica.label} · ${money(e.getNodeCost(replica), 2)}/hr. Connect it if you need a different read path.` });
  }

  /* ------------------------------------------------------------------ */
  /* ACTIONS                                                             */
  /* ------------------------------------------------------------------ */
  function scaleDownSelected() {
    const e = state.engine;
    const n = state.selectedId ? e.nodes.get(state.selectedId) : null;
    if (!n) return;
    const relief = e.scaleDownNode(n.id);
    if (!relief) {
      toast({ tone: 'warn', icon: 'circle-x', title: 'Cannot scale down', message: 'This node has no lower tier.' });
      return;
    }
    if (relief.removed) state.selectedId = null;
    renderGraph();
    renderAll(true);
    processEvents();
    toast({ tone: 'warn', icon: 'arrow-down-to-line', title: relief.removed ? 'Node taken down' : 'Scaled down', message: relief.detail + ` Cost ${money(relief.beforeCost)} → ${money(relief.afterCost)}/hr.` });
  }

  function takeDownNode(id, label) {
    const e = state.engine;
    const n = e.nodes.get(id);
    if (!n) return;
    if (n.type === 'internet') {
      toast({ tone: 'warn', icon: 'globe', title: 'Source protected', message: 'Internet is the traffic source and cannot be taken down.' });
      return;
    }
    openConfirm(
      'Take down node?',
      `Remove <b>${esc(n.label)}</b> from the graph? This saves <b>${money(e.getNodeCost(n), 2)}/hr</b> and frees its cost, but deletes all of its capacity and wires. This is the deliberate "take the infra down under pressure" lever.`,
      () => {
        const cost = e.getNodeCost(n);
        e.removeNode(n.id);
        if (state.selectedId === n.id) state.selectedId = null;
        renderGraph();
        renderAll(true);
        processEvents();
        toast({ tone: 'warn', icon: 'power', title: 'Node taken down', message: `${n.label} removed · saved ${money(cost, 2)}/hr.` });
      }
    );
  }

  function deleteSelected() {
    if (!state.selectedId) return;
    takeDownNode(state.selectedId);
  }

  function openPressureModal() {
    const e = state.engine;
    if (!e) return;
    const hot = e.getPressureNodes();
    const exhausted = (e.metrics && e.metrics.capacityExhausted) || e.lastDroppedRPS > 0.5;
    const rows = hot.map((n) => `
      <div class="pressure-row">
        <div class="pr-info">
          <div class="pr-name">${icon(n.icon)} <span>${esc(n.label)}</span></div>
          <div class="pr-meta">${esc(n.type)} · ${money(e.getNodeCost(n), 2)}/hr · ${n.category === 'database' ? `${e.dbStats(n).shards} shards / ${e.dbStats(n).replicas} replicas` : n.category === 'compute' ? `${n.config.cores || '?'}c/${n.config.ram || '?'}GB` : n.category}</div>
        </div>
        <div class="pr-load">${Math.round((n.load || 0) * 100)}%</div>
        <button class="btn mini" data-action="pressure-scale" data-node="${esc(n.id)}">${icon('arrow-down-to-line')} Scale</button>
        <button class="btn mini danger" data-action="pressure-take" data-node="${esc(n.id)}">${icon('power')} Down</button>
      </div>`).join('');
    openModal({
      kind: 'pressure',
      title: exhausted ? 'Capacity exhausted — pressure relief' : 'Under-pressure nodes',
      icon: 'gauge',
      sub: `${hot.length} hot node${hot.length === 1 ? '' : 's'} · ${Math.round((e.utilization || 0) * 100)}% peak load`,
      body: `
        <div class="tiny" style="margin-bottom:8px;color:#cbd5e1">
          When the infrastructure is exhausted, you have three levers: <b>add capacity</b>, <b>buffer with a queue</b>, or <b>deliberately take the under-pressure thing down</b>. Taking it down preserves budget but removes capacity — use it as a controlled sacrifice, not a free fix.
        </div>
        ${rows || `<div class="empty-note">No individual node is above 80% load. Exhaustion may be coming from a failed node, a missing path, or aggregate request drops. Check warnings and the ops feed.</div>`}
        ${exhausted ? `<div class="pressure-note" style="margin-top:8px;border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.06);color:#fecaca"><b>Exhausted:</b> ${fmt(e.lastDroppedRPS)} RPS dropped. A queue can absorb overflow; more app/DB capacity serves it.</div>` : ''}
      `,
      footer: `
        <button class="btn ghost" data-action="close-modal">Close</button>
        <button class="btn danger" data-action="pressure-scale-hottest" ${hot.length ? '' : 'disabled'}>${icon('arrow-down-to-line')} Scale down hottest</button>
      `,
    });
  }

  function openModal(opts) {
    const root = $('#modalRoot');
    const panel = $('#modalPanel');
    state.modalKind = opts.kind || 'generic';
    state.modalDismissible = opts.dismissible !== false;
    panel.className = 'modal' + (opts.wide ? ' wide' : '');
    $('#modalHead').innerHTML = `
      <div class="mh-icon">${icon(opts.icon || 'info')}</div>
      <h2>${opts.title || ''}</h2>
      ${opts.sub ? `<div class="mh-sub">${esc(opts.sub)}</div>` : ''}
      <button class="mh-close" data-action="close-modal" title="Close">${icon('x')}</button>`;
    $('#modalBody').innerHTML = opts.body || '';
    $('#modalFoot').innerHTML = opts.footer || `<button class="btn" data-action="close-modal">Close</button>`;
    root.classList.remove('hidden');
    refreshIcons();
  }

  function closeModal() {
    if (!state.modalDismissible) return;
    $('#modalRoot').classList.add('hidden');
    state.modalKind = null;
    state.confirmCb = null;
  }

  function openConfirm(title, body, onConfirm) {
    state.confirmCb = onConfirm;
    openModal({
      kind: 'confirm', title, icon: 'triangle-alert',
      body: `<div style="font-size:10px;line-height:1.6;color:#cbd5e1">${body}</div>`,
      footer: `<button class="btn ghost" data-action="confirm-cancel">Cancel</button><button class="btn danger" data-action="confirm-yes">${icon('check')} Confirm</button>`,
    });
  }

  function showGameOver() {
    const e = state.engine;
    if (!e || state.gameOverShown) return;
    state.gameOverShown = true;
    stopTimer();
    const sc = e.lastScorecard || e.buildScorecard();
    const victory = !!sc.victory;
    const recs = sc.recommendations.length ? sc.recommendations : ['Solid run. Try the next seed with a lower cost target.'];
    const body = `
      <div class="score-hero ${victory ? 'victory' : ''}">
        <div class="sh-kicker">${victory ? 'Gauntlet Cleared' : 'Run Ended'}</div>
        <div class="sh-score">${fmt(sc.score)}</div>
        <div class="sh-reason">${esc(sc.reason)}</div>
      </div>
      <div class="score-grid">
        <div class="score-stat"><div class="ss-label">Waves</div><div class="ss-value">${sc.wavesSurvived}/${sc.totalWaves}</div></div>
        <div class="score-stat"><div class="ss-label">Peak RPS</div><div class="ss-value">${fmt(sc.peakRps)}</div></div>
        <div class="score-stat"><div class="ss-label">Availability</div><div class="ss-value">${sc.availability}%</div></div>
        <div class="score-stat"><div class="ss-label">Cost spent</div><div class="ss-value">${money(sc.costSpent, 3)}</div></div>
        <div class="score-stat"><div class="ss-label">Mitigated</div><div class="ss-value" style="color:#6ee7b7">${sc.attacksMitigated}</div></div>
        <div class="score-stat"><div class="ss-label">Missed</div><div class="ss-value" style="color:#fca5a5">${sc.attacksMissed}</div></div>
        <div class="score-stat"><div class="ss-label">Reputation</div><div class="ss-value">${sc.reputation}</div></div>
        <div class="score-stat"><div class="ss-label">Failures</div><div class="ss-value">${sc.failures}</div></div>
      </div>
      <div class="recommend">
        <h3>What you should have added</h3>
        <ul>${recs.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        ${sc.idleNodes && sc.idleNodes.length ? `<div class="tiny" style="margin-top:5px;color:#fbbf24">Idle at the end: ${sc.idleNodes.map(esc).join(', ')}</div>` : ''}
      </div>`;
    openModal({
      kind: 'gameover', title: victory ? 'Gauntlet cleared' : 'Game over', icon: victory ? 'trophy' : 'skull',
      sub: `seed ${e.seedInput} · ${(e.simTime / 1000).toFixed(0)}s simulated`, wide: true, dismissible: true,
      body,
      footer: `
        <button class="btn" data-action="close-modal">Review board</button>
        <button class="btn" data-action="restart-new">${icon('dices')} New seed</button>
        <button class="btn primary" data-action="restart-same">${icon('rotate-ccw')} Run this seed again</button>`,
    });
  }

  /* ------------------------------------------------------------------ */
  /* SELF-TEST                                                           */
  /* ------------------------------------------------------------------ */
  function openSelfTest() {
    if (state.selfTestBusy) return;
    state.selfTestBusy = true;
    const testTotal = ST && ST.TESTS ? ST.TESTS.length : 12;
    const wasRunning = state.engine.started && !state.engine.paused && !state.engine.gameOver;
    state.engine.pause();
    stopTimer();
    updateButtons();
    openModal({
      kind: 'selftest', title: 'Built-in Self-Test', icon: 'flask-conical',
      sub: `${testTotal} isolated checks`, wide: true, dismissible: true,
      body: `
        <div class="test-summary">
          <span class="test-count" id="testCount">Running ${testTotal} tests…</span>
          <div class="test-progress"><i id="testProgress"></i></div>
          <span class="badge info" id="testResultBadge">${icon('loader')} running</span>
        </div>
        <div class="test-log" id="testLog"></div>
        <div class="tiny" style="margin-top:6px">Simulation is paused while tests run. Results are also printed to the browser console.</div>`,
      footer: `<button class="btn ghost" data-action="selftest-resume" ${wasRunning ? '' : 'disabled'}>${icon('play')} Resume sim</button><button class="btn" data-action="close-modal">Close</button>`,
    });
    setTimeout(() => {
      const logEl = $('#testLog');
      const progress = $('#testProgress');
      let index = 0;
      let output;
      try {
        if (!ST) throw new Error('Self-test module not loaded');
        console.log('%c InfraGauntlet — Self-Test ', 'background:#0891b2;color:#fff;padding:2px 6px;border-radius:3px');
        output = ST.runAll((r) => {
          index++;
          const line = document.createElement('div');
          line.className = 'row';
          line.innerHTML = `<span class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'} #${r.id}</span> ${esc(r.name)} <span class="tiny">(${r.ms}ms)</span><span class="detail">${esc(r.detail)}</span>`;
          logEl.appendChild(line);
          logEl.scrollTop = logEl.scrollHeight;
          if (progress) progress.style.width = Math.round((index / ST.TESTS.length) * 100) + '%';
          console[r.pass ? 'log' : 'error'](`[Self-Test] ${r.pass ? 'PASS' : 'FAIL'} #${r.id} ${r.name} — ${r.detail}`);
        });
        const passed = output.passed;
        const total = output.total;
        const count = $('#testCount');
        if (count) count.textContent = `${passed}/${total} passed${output.allPassed ? ' — all green' : ' — see failures'}`;
        const badge = $('#testResultBadge');
        if (badge) {
          badge.className = `badge ${output.allPassed ? 'ok' : 'bad'}`;
          badge.innerHTML = `${icon(output.allPassed ? 'circle-check' : 'circle-x')} ${output.allPassed ? 'PASS' : 'FAIL'}`;
        }
        if (progress) progress.style.background = output.allPassed ? '#34d399' : '#f87171';
        console.log(`[Self-Test] ${passed}/${total} passed` + (output.allPassed ? ' — ALL PASS' : ''));
        toast({ tone: output.allPassed ? 'good' : 'bad', icon: 'flask-conical', title: 'Self-test complete', message: `${passed}/${total} checks passed. ${output.allPassed ? 'All systems go.' : 'Open the log for failures.'}`, duration: 7000 });
      } catch (err) {
        const logEl2 = $('#testLog');
        if (logEl2) logEl2.innerHTML = `<div class="row fail">Harness error: ${esc(err.message)}</div>`;
        const count = $('#testCount');
        if (count) count.textContent = 'Harness error';
        console.error(err);
      } finally {
        state.selfTestBusy = false;
        refreshIcons();
      }
    }, 60);
  }

  function showHelp() {
    openModal({
      kind: 'help', title: 'InfraGauntlet — Field Manual', icon: 'circle-help', wide: true,
      body: `
        <div class="help-grid">
          <div class="help-card"><h3>The loop</h3><p>Every 500ms traffic enters from Internet and is routed along directed wires to DB / cache / S3 handlers. Capacity limits throughput. Overflow is buffered by queues or dropped. Availability below 50% for 15s, reputation 0, or 30s over budget ends the run.</p></div>
          <div class="help-card"><h3>Build</h3><p>Drag from the palette or click. Connect via a node's right port. Right-click a wire to delete. Dev/ops/security nodes auto-attach as sidecars; remove the wire if you want them idle (and still paid for).</p></div>
          <div class="help-card"><h3>Warnings</h3><p>Capacity exhaustion, idle spend, queue backpressure, budget, availability and reputation warnings appear over the canvas. <b>Under pressure?</b> opens the pressure-relief panel.</p></div>
          <div class="help-card"><h3>Take infra down</h3><p>Scale down a compute tier, remove DB shards/replicas, or take a node down entirely. Cost falls immediately, capacity disappears immediately. Use this deliberately when a node is too hot and you need to protect the budget.</p></div>
          <div class="help-card"><h3>Attacks</h3><p>Volumetric attacks multiply traffic. App/auth attacks inject errors and reputation damage. Put the listed mitigations on the graph. The Teach card explains every attack and why it worked.</p></div>
          <div class="help-card"><h3>DB scaling</h3><p>Writes = base writes × shards. Reads = base reads × (1 + replicas). Cost = base × shards × (1 + replicas × 0.6). More than 3 replicas per shard adds replication-lag risk.</p></div>
          <div class="help-card"><h3>Failures</h3><p>Each failure has a nominal recovery time. CI/CD cuts it by 60%; Monitoring detects 3s earlier; GitHub rollback prevents data loss; Slack preserves reputation. Kafka/RabbitMQ turn DB outages into backpressure.</p></div>
          <div class="help-card"><h3>Incident runbook</h3><p>When App, LB, DB, cache or queue fails, the runbook card gives the immediate action: failover, buffer, add a replica, or add a redundant LB. A second LB turns an LB outage into a ~1.2s ingress blip; a second app server keeps the pool serving.</p></div>
          <div class="help-card"><h3>Keys</h3><p><span class="kbd">Space</span>+drag pan · wheel zoom · <span class="kbd">Del</span> take down selected · <span class="kbd">Esc</span> cancel link / close modal. Seed 12345 is the deterministic test seed.</p></div>
        </div>`,
      footer: `<button class="btn" data-action="close-modal">Close</button>`,
    });
  }

  /* ------------------------------------------------------------------ */
  /* GAME CONTROLS                                                       */
  /* ------------------------------------------------------------------ */
  function startTimer() {
    stopTimer();
    state.timer = setInterval(() => {
      const e = state.engine;
      if (!e || e.paused || !e.started || e.gameOver) return;
      e.tick(0.5);
      afterTick();
    }, TICK_MS / state.speed);
  }

  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function startGame() {
    const e = state.engine;
    if (!e) return;
    if (e.gameOver || e.victory) {
      loadNewGame(e.seedInput, { start: true, announce: true });
      return;
    }
    if (!e.started) {
      e.begin();
      state.lastWaveIndex = e.waveIndex - 1;
      flashWave();
      processEvents();
    }
    e.resume();
    startTimer();
    afterTick();
    updateButtons();
  }

  function togglePause() {
    const e = state.engine;
    if (!e || !e.started || e.gameOver) return;
    if (e.paused) {
      e.resume();
      startTimer();
      afterTick();
    } else {
      e.pause();
      stopTimer();
      renderAll(true);
      toast({ tone: 'info', icon: 'pause', title: 'Simulation paused', message: 'The graph is frozen. Configure nodes, then resume.' });
    }
    updateButtons();
  }

  function resetGame() {
    const raw = $('#seedInput').value.trim();
    const seed = raw ? raw : randomSeed();
    loadNewGame(seed, { start: false, announce: true });
    toast({ tone: 'info', icon: 'rotate-ccw', title: 'Run reset', message: `Seed ${seed}. Starting nodes are unconnected; press Start when ready.` });
  }

  function afterTick() {
    const e = state.engine;
    if (!e) return;
    if (e.waveIndex !== state.lastWaveIndex) {
      state.lastWaveIndex = e.waveIndex;
      flashWave();
      state.configSig = '';
    }
    processEvents();
    renderMetrics();
    renderWarnings();
    renderTimeline();
    renderAttackCard();
    renderRunbook();
    renderConfigPanel();
    renderOpsFeed();
    renderHint();
    updateGraphVisuals();
    updateButtons();
    updateClockOnly();
    if (e.gameOver || e.victory) {
      stopTimer();
      showGameOver();
    } else if (e.metrics && e.metrics.capacityExhausted) {
      const now = performance.now();
      if (now > state.exhaustToastAt) {
        state.exhaustToastAt = now + 7000;
        toast({ tone: 'bad', icon: 'flame', title: 'Capacity exhausted', message: `${fmt(e.lastDroppedRPS)} RPS dropped. Add capacity, add a queue, or open pressure relief.`, duration: 5200 });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* UI BINDING                                                          */
  /* ------------------------------------------------------------------ */
  function bindUI() {
    $('#btnStart').addEventListener('click', startGame);
    $('#btnPause').addEventListener('click', togglePause);
    $('#btnReset').addEventListener('click', resetGame);
    $('#btnSelfTest').addEventListener('click', openSelfTest);
    $('#btnHelp').addEventListener('click', showHelp);
    $('#btnTestSeed').addEventListener('click', () => {
      $('#seedInput').value = String(D.TEST_SEED);
      loadNewGame(D.TEST_SEED, { start: false, announce: true });
    });
    $('#btnNewSeed').addEventListener('click', () => {
      const seed = randomSeed();
      $('#seedInput').value = String(seed);
      loadNewGame(seed, { start: false, announce: true });
    });
    $('#seedInput').addEventListener('change', () => {
      const v = $('#seedInput').value.trim();
      if (!v) $('#seedInput').value = String(state.engine.seedInput);
    });
    $('#budgetRange').addEventListener('input', (ev) => {
      const e = state.engine;
      e.budgetPerHour = Number(ev.target.value) || 1;
      $('#budgetVal').textContent = money(e.budgetPerHour, 0) + '/hr';
      renderMetrics();
      renderWarnings();
    });
    $('#speedToggle').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-speed]');
      if (!btn) return;
      state.speed = Number(btn.dataset.speed) || 1;
      updateButtons();
      if (state.engine.started && !state.engine.paused) startTimer();
    });
    $('#btnZoomIn').addEventListener('click', () => zoomStage(1.12));
    $('#btnZoomOut').addEventListener('click', () => zoomStage(0.89));
    $('#btnFit').addEventListener('click', fitGraph);
    $('#budgetRange').setAttribute('title', 'Budget ($/hr): exceeding it for 30s ends the run');

    // Palette category tabs
    $('#paletteTabs').addEventListener('click', (ev) => {
      const tab = ev.target.closest('[data-category]');
      if (!tab) return;
      state.paletteCategory = tab.dataset.category;
      $$('#paletteTabs .palette-tab').forEach((b) => b.classList.toggle('active', b === tab));
      renderPaletteCategory();
    });

    // Palette
    const palette = $('#paletteList');
    palette.addEventListener('click', (ev) => {
      const item = ev.target.closest('[data-type]');
      if (!item) return;
      if (Date.now() - state.dragEndedAt < 250) return;
      const pos = nextFreePosition();
      addNodeAt(item.dataset.type, pos.x, pos.y);
    });
    palette.addEventListener('dragstart', (ev) => {
      const item = ev.target.closest('[data-type]');
      if (!item) return;
      state.dragType = item.dataset.type;
      item.classList.add('is-dragging');
      try {
        ev.dataTransfer.setData('application/x-infra-node', state.dragType);
        ev.dataTransfer.setData('text/plain', state.dragType);
        ev.dataTransfer.effectAllowed = 'copy';
        const ghost = item.cloneNode(true);
        ghost.classList.add('palette-drag-ghost');
        ghost.classList.remove('is-dragging');
        document.body.appendChild(ghost);
        ev.dataTransfer.setDragImage(ghost, 24, 24);
        setTimeout(() => ghost.remove(), 0);
      } catch (err) { /* older browsers */ }
    });
    palette.addEventListener('dragend', () => {
      state.dragEndedAt = Date.now();
      state.dragType = null;
      $$('#paletteList .palette-item').forEach((el) => el.classList.remove('is-dragging'));
      hideDropOverlay();
    });

    // Config panel delegation
    $('#configPanel').addEventListener('input', onConfigInput);
    $('#configPanel').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'connect-node') {
        startLinking(state.selectedId);
      } else if (action === 'delete-node' || action === 'take-down') {
        takeDownNode(state.selectedId);
      } else if (action === 'scale-down') {
        scaleDownSelected();
      } else if (action === 'add-replica') {
        const n = state.selectedId ? state.engine.nodes.get(state.selectedId) : null;
        if (n) addReadReplicaFor(n);
      } else if (action === 'convert-sharded') {
        const n = state.selectedId ? state.engine.nodes.get(state.selectedId) : null;
        if (n) {
          n.config.sharded = true;
          if (!/sharded/i.test(n.label)) n.label += ' (Sharded)';
          n.icon = 'layers';
          state.engine.updateDerived();
          renderGraph();
          renderAll(true);
          toast({ tone: 'good', icon: 'layers', title: 'Sharded cluster', message: `${n.label} converted. Increase shards to scale writes.` });
        }
      } else if (action === 'delete-edge') {
        const key = btn.dataset.edgeKey;
        if (state.engine.disconnect(key)) {
          renderGraph();
          renderAll(true);
          toast({ tone: 'warn', icon: 'unplug', title: 'Wire deleted', message: 'Traffic will re-route on the next tick.' });
        }
      } else if (action === 'open-pressure') {
        openPressureModal();
      }
    });

    // Runbook actions
    $('#runbookCard').addEventListener('click', (ev) => {
      const run = ev.target.closest('[data-runbook]');
      if (run) {
        deployForRunbook(run.dataset.runbook);
        return;
      }
      const act = ev.target.closest('[data-action="open-pressure"]');
      if (act) openPressureModal();
    });

    // Warning actions
    $('#warningStack').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'highlight-idle') {
        const idle = state.engine.idleNodes();
        if (idle.length) {
          state.highlightIdleUntil = performance.now() + 4500;
          selectNode(idle[0].id);
          renderGraph();
          renderAll(true);
          toast({ tone: 'warn', icon: 'unplug', title: 'Idle nodes highlighted', message: `${idle.length} node${idle.length > 1 ? 's are' : ' is'} charging cost with zero traffic.` });
        }
      } else if (action === 'relieve') {
        openPressureModal();
      } else if (action === 'budget') {
        $('#budgetRange').focus();
        toast({ tone: 'warn', icon: 'circle-dollar-sign', title: 'Budget control', message: 'Raise the budget slider or take down idle/under-pressure nodes.' });
      }
    });

    // context menu
    $('#contextMenu').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-edge-action="delete"]');
      if (!btn) return;
      const key = state.contextEdgeKey;
      hideContextMenu();
      if (key && state.engine.disconnect(key)) {
        renderGraph();
        renderAll(true);
        toast({ tone: 'warn', icon: 'unplug', title: 'Wire deleted', message: 'Right-click deletion applied to the graph.' });
      }
    });
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('#contextMenu') && !ev.target.closest('[data-action="delete-edge"]')) hideContextMenu();
    });
    $('#canvasWrap').addEventListener('click', () => hideContextMenu());

    // Modal delegation
    $('#modalRoot').addEventListener('click', (ev) => {
      if (ev.target.id === 'modalRoot' && state.modalDismissible) { closeModal(); return; }
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'close-modal') {
        closeModal();
      } else if (action === 'confirm-cancel') {
        state.confirmCb = null;
        closeModal();
      } else if (action === 'confirm-yes') {
        const cb = state.confirmCb;
        state.confirmCb = null;
        closeModal();
        if (cb) cb();
      } else if (action === 'restart-same') {
        const seed = state.engine.seedInput;
        closeModal();
        loadNewGame(seed, { start: true, announce: true });
      } else if (action === 'restart-new') {
        closeModal();
        loadNewGame(randomSeed(), { start: true, announce: true });
      } else if (action === 'pressure-scale-hottest') {
        const r = state.engine.relievePressure();
        if (!r) {
          toast({ tone: 'warn', icon: 'gauge', title: 'No hot nodes', message: 'Nothing is above 80% load; check path failures instead.' });
          return;
        }
        renderGraph();
        renderAll(true);
        processEvents();
        openPressureModal();
        toast({ tone: 'warn', icon: 'arrow-down-to-line', title: 'Pressure relieved', message: r.detail + ` Cost ${money(r.beforeCost)} → ${money(r.afterCost)}/hr.` });
      } else if (action === 'pressure-scale') {
        const id = btn.dataset.node;
        const r = state.engine.scaleDownNode(id);
        if (r) {
          if (state.selectedId === id && r.removed) state.selectedId = null;
          renderGraph();
          renderAll(true);
          processEvents();
          openPressureModal();
          toast({ tone: 'warn', icon: 'arrow-down-to-line', title: 'Scaled down', message: r.detail + ` Cost ${money(r.beforeCost)} → ${money(r.afterCost)}/hr.` });
        }
      } else if (action === 'pressure-take') {
        const id = btn.dataset.node;
        const n = state.engine.nodes.get(id);
        closeModal();
        if (n) takeDownNode(id);
      } else if (action === 'selftest-resume') {
        closeModal();
        if (state.engine.started && !state.engine.gameOver && !state.engine.victory) {
          state.engine.resume();
          startTimer();
          updateButtons();
          toast({ tone: 'info', icon: 'play', title: 'Simulation resumed', message: 'Self-test complete; the run continues.' });
        }
      }
    });

    // keyboard
    document.addEventListener('keydown', (ev) => {
      const tag = (ev.target && ev.target.tagName) || '';
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (ev.code === 'Space' && !inField) {
        ev.preventDefault();
        if (!state.spaceHeld) {
          state.spaceHeld = true;
          if (state.stage) state.stage.draggable(true);
          $('#canvasWrap').style.cursor = 'grab';
        }
      } else if (ev.key === 'Escape') {
        if (!$('#modalRoot').classList.contains('hidden')) {
          if (state.modalDismissible) closeModal();
        } else if (state.linkingFrom) {
          stopLinking();
        } else {
          hideContextMenu();
        }
      } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && !inField) {
        if (state.selectedId) {
          ev.preventDefault();
          deleteSelected();
        }
      }
    });
    document.addEventListener('keyup', (ev) => {
      if (ev.code === 'Space') {
        state.spaceHeld = false;
        if (state.stage) state.stage.draggable(false);
        $('#canvasWrap').style.cursor = 'default';
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.engine && state.engine.started && !state.engine.paused && !state.engine.gameOver) {
        state.engine.pause();
        stopTimer();
        updateButtons();
        toast({ tone: 'warn', icon: 'pause', title: 'Auto-paused', message: 'Tab hidden. The run is paused so you do not lose availability in the background.' });
      }
    });

    // Drag/drop onto the canvas: stop click bubbling from canvas host.
    $('#canvasHost').addEventListener('click', (ev) => ev.stopPropagation());
    window.addEventListener('resize', () => {
      if (state.stage) resizeCanvas();
    });
  }

  /* ------------------------------------------------------------------ */
  /* PALETTE                                                             */
  /* ------------------------------------------------------------------ */
  function buildPalette() {
    const tabs = $('#paletteTabs');
    const list = $('#paletteList');
    if (!tabs || !list) return;
    const total = D.PALETTE.reduce((sum, g) => sum + g.types.length, 0);
    $('#paletteCount').textContent = total;
    if (!D.PALETTE.some((g) => g.category === state.paletteCategory)) state.paletteCategory = 'network';
    tabs.innerHTML = D.PALETTE.map((group) => {
      const cat = D.CATEGORIES[group.category];
      const meta = PALETTE_META[group.category] || { short: cat.label };
      return `<button class="palette-tab ${state.paletteCategory === group.category ? 'active' : ''}" data-category="${group.category}" title="${esc(cat.label)}">
        ${icon(cat.icon)}<span>${esc(meta.short)}</span>
      </button>`;
    }).join('');
    renderPaletteCategory();
    refreshIcons();
  }

  function renderPaletteCategory() {
    const group = D.PALETTE.find((g) => g.category === state.paletteCategory) || D.PALETTE[0];
    const cat = D.CATEGORIES[group.category];
    const meta = PALETTE_META[group.category] || { short: cat.label, blurb: '' };
    const active = $('#paletteActive');
    if (active) {
      active.innerHTML = `
        <div class="pa-icon">${icon(cat.icon)}</div>
        <div class="pa-copy">
          <div class="pa-title">${esc(cat.label)}</div>
          <div class="pa-sub">${esc(meta.blurb)} · ${group.types.length} components</div>
        </div>
        <div class="pa-drag">DRAG TO DEPLOY</div>`;
    }
    const list = $('#paletteList');
    if (!list) return;
    const items = group.types.map((type) => D.COMPONENT_BY_TYPE[type]).filter(Boolean);
    list.innerHTML = items.map((comp) => {
      const cost = comp.type === 'app_custom' ? 'custom pricing' : `$${Number(comp.costPerHour).toFixed(comp.costPerHour < 0.1 ? 3 : 2)}/hr`;
      const cap = comp.baseCapacityRPS === Infinity || comp.baseCapacityRPS >= 1e8 ? 'control plane' : `${fmt(comp.baseCapacityRPS)} RPS`;
      const detail = comp.category === 'compute' ? `${comp.config.cores || 1}c / ${comp.config.ram || 1}GB · ${cost}` : `${cost} · ${cap}`;
      const title = `${comp.label} · ${cost} · ${cap}\n${comp.description || ''}`;
      return `<button class="palette-item" draggable="true" data-type="${comp.type}" title="${esc(title)}" style="--item-color:${comp.color}">
        <span class="pi-icon">${icon(comp.icon)}</span>
        <span class="pi-copy">
          <span class="pi-name">${esc(comp.label)}</span>
          <span class="pi-sub">${esc(detail)}</span>
        </span>
        <span class="pi-grip">${icon('grip-vertical')}</span>
      </button>`;
    }).join('');
    refreshIcons();
  }

  /* ------------------------------------------------------------------ */
  /* DEBUG HOOK (useful for QA and the browser console; not part of UI)   */
  /* ------------------------------------------------------------------ */
  window.__IG = {
    get engine() { return state.engine; },
    get state() { return state; },
    get stage() { return state.stage; },
    addNodeAt, selectNode, startLinking, finishLinking, startGame, loadNewGame,
    renderGraph, renderAll, fitGraph, openPressureModal, openSelfTest, afterTick,
  };

  /* ------------------------------------------------------------------ */
  /* GO                                                                  */
  /* ------------------------------------------------------------------ */
  try {
    boot();
  } catch (err) {
    console.error('InfraGauntlet boot failed', err);
    const body = document.body;
    const pre = document.createElement('pre');
    pre.style.cssText = 'position:fixed;inset:20px;z-index:999;color:#fecaca;background:#1a0b10;border:1px solid #f87171;border-radius:8px;padding:20px;overflow:auto;font-size:13px;white-space:pre-wrap';
    pre.textContent = 'InfraGauntlet failed to boot:\n\n' + (err && err.stack ? err.stack : err) + '\n\nCheck that vendor/konva.min.js and js/data.js loaded.';
    body.appendChild(pre);
  }
})();
