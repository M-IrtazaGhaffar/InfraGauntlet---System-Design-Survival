# InfraGauntlet

A single-page, client-only **System Design / DevOps survival simulator** built with vanilla JS, Konva.js, Tailwind (Play CDN build) and Lucide icons. No backend, no build step, no account.

The presentation layer is a custom control-room theme using vendored **Space Grotesk** and **JetBrains Mono**, a green/blue thunder mark, real SVG line icons everywhere (including inside the Konva canvas), animated incoming-request particles, a category-tab component library, and an incident runbook for App / LB / DB / cache / queue failures.

## Run

Open **`index.html`** directly in Edge / Chrome / Firefox. The app loads all libraries from the vendored `vendor/` folder, so it works offline (file:// is supported).

Optional static server:

```powershell
python -m http.server 8080
# then open http://localhost:8080
```

## Controls

| Action | How |
|---|---|
| Add a node | Click a palette item, or drag it onto the canvas |
| Move a node | Drag the node |
| Connect | Click the node's right-side **+** port, then click the destination |
| Delete a connection | Right-click the wire |
| Delete a node | Select it, press `Delete` / `Backspace`, or use **Take down node** |
| Zoom | Mouse wheel, or the zoom buttons |
| Pan | Hold `Space` and drag an empty part of the canvas |
| Cancel a link / close a modal | `Esc` |
| Pause / resume | Pause button (`Resume` when paused) |
| Speed | 1x / 2x / 4x changes tick frequency; simulation step stays 500 ms |
| Seed | Enter a seed and Reset, or use `12345` for the deterministic test seed |

## The loop

Every 500 ms simulated:

1. The current wave advances (base RPS = `100 * 1.3^waveIndex`, 15-30 s long, read/write split, burstiness, optional attack/failure).
2. Traffic is routed from Internet over directed wires to handlers (DB, cache, S3). Shared node capacities are allocated across paths; overflow goes to queues (Kafka/RabbitMQ) or is dropped.
3. Attack effects, failures and mitigation checks are applied.
4. Metrics update: served/dropped RPS, p99 latency, error rate, rolling availability, reputation, cost/hr, total spend, load.
5. Every node charges cost every tick, **connected or idle**.

A run ends when any of these is true:

- Availability stays below 50% for 15 s
- Reputation reaches 0
- Cost/hr is over budget for 30 s
- All 30 waves complete (victory)

## One-screen layout

The shell uses `height:100dvh` and strict `minmax(0,1fr)` grid rows. The page itself never scrolls. The palette uses category tabs plus a controlled component list, so every one of the 31 components is reachable without scrolling through a long sidebar. The right inspector scrolls internally only when a dense config/runbook card needs more room.

The board also animates **request particles**: small green/blue dots travel along wires that are carrying traffic, so load is visible without opening the metrics.

## Exhaustion warning and deliberate take-down

- **CAPACITY EXHAUSTED** banner appears as soon as traffic drops or peak utilization crosses the threshold. It distinguishes raw capacity exhaustion from a failed/disconnected path.
- **Capacity nearly exhausted** warning appears proactively at >85% peak load.
- **Idle spend** warning names the wasted dollars and has a "Show nodes" action.
- **Budget** warning shows the 30-second shutdown countdown.
- **Under pressure?** opens the pressure-relief panel. From there you can:
  - Scale a hot compute node down one tier
  - Remove a DB read replica or shard
  - Take the node down entirely (cost goes down, capacity goes away)
- The same controls are in the selected-node inspector under **Danger zone**.

This intentionally makes "take the under-pressure thing down" a real trade-off: it protects the budget but can make availability worse. The warning compares cost saved with the capacity you lose.

## When the app or load balancer goes down

The right panel opens an **Incident Runbook** card for the active failure:

- **App server down:** traffic fails over to the remaining app pool. If the pool is empty, the runbook can deploy a spare app server and wire it to the healthy databases. Do not scale down another app while the pool is recovering.
- **Load balancer down:** if a second reachable LB exists, ingress fails over after a ~1.2s blip. If not, ingress is down until recovery. The runbook can add a redundant LB, and the engine detects it immediately during the outage. It also warns you not to take down the database/cache while failover is in progress.
- **Database down:** queue buffers absorb overflow; without a queue the runbook offers to add Kafka. Read replicas keep reads alive; writes need the primary.
- **Cache down:** reads fall through to the DB. The runbook offers a read replica to prevent a read stampede.
- **Queue down:** backpressure disappears; add a second queue.

The runbook shows live pool counts (Apps / LBs / DBs / Queues) and the auto-recovery timer. All 15 built-in tests, including replica routing, sharding throughput and redundant-LB failover, run from the Self-Test button.

## Project structure

```
index.html             Layout, theme, README block, script loading
js/data.js             Component catalog (31), attacks (30), failures (6), constants
js/engine.js           DOM-free simulation engine, routing, costs, game-over rules
js/selftest.js         15 isolated checks used by the Self-Test button
js/app.js              Konva canvas, UI panels, modals, toasts, controls, QA hook
vendor/                Pinned library builds for offline play:
                       Konva 9.3.18, Tailwind Play 3.4.17, Lucide 0.468.0,
                       Space Grotesk + JetBrains Mono woff2
```

The UI is intentionally classic-script modular rather than `type="module"` so that `index.html` works when opened directly from `file://` without a server (ES module CORS blocks file URLs in browsers). The modules communicate through the `window.IGData`, `window.IGEngine`, `window.IGSelfTest` namespaces.

## Add a component

Edit `js/data.js` -> `COMPONENTS`:

```js
my_node: {
  type: 'my_node', label: 'My Node', category: 'network', icon: 'server',
  color: '#22d3ee', costPerHour: 0.1,
  baseCapacityRPS: 10000, latencyMs: 2, health: 100,
  config: {}, mitigations: [], failureMode: '...', description: '...'
}
```

Add it to `PALETTE` under a category. Categories `database`, `cache` and `storage` are routing handlers; other categories are pass-through/support nodes.

## Add an attack

Add to `ATTACKS` in `js/data.js`; the wave generator, Teach card, mitigation chips, toast, Slack alert and self-test automatically pick it up:

```js
{
  id: 'my_attack',
  name: 'My Attack',
  icon: 'zap',                    // valid Lucide name
  category: 'application',
  waveMultiplier: 1.5,            // >1 adds traffic; 1 = integrity attack
  maliciousRatio: 0.2,
  targetLayer: 'app',
  repDamage: 6,
  errorRate: 0.15,
  target: 'app',                  // edge|app|auth|db|cache|random
  mitigations: ['waf', 'apigw'],  // node types or app/db/queue/cache tokens
  forcedFailure: null,            // optional failure id
  effectIfUnmitigated: '...',
  effectIfMitigated: '...',
  teach: '...'
}
```

## Built-in tests

Click **Self-Test** in the footer. All 15 checks run against isolated engines and print PASS/FAIL to the browser console and to an on-screen log. The extra checks cover live read-replica routing, routed write scaling under sharding, and redundant-LB failover.

## Known limitations / deliberate design notes

- **Routing model:** simple-path enumeration (max 10 hops, 220 paths) with greedy capacity allocation. It is deterministic and teaches the concepts; it is not a production network simulator.
- **30 attacks in one run:** normal runs choose attacks stochastically and intentionally have about 30% quiet waves, so a single run will not necessarily expose all 30 attacks. Self-Test #12 validates all 30 through a deterministic 30-wave coverage schedule. If you want to see them all in play, keep adding attack-forcing runs from the console or use the coverage harness.
- **UI modules** use classic scripts rather than browser ES modules so file:// offline play works. They are separated by responsibility and namespaced.
- **DevOps / security sidecars:** nodes in these categories and most network nodes are auto-attached to Internet when dropped so mitigation effects are unambiguous. If you delete that wire they become idle and still charge cost.
- **LB failover:** a single LB failure is a total ingress outage. A second reachable LB turns it into a ~1.2s blip. Adding a redundant LB during an outage is detected on the next tick and restores ingress after the blip.
- **Visuals:** every icon in the UI and on the Konva canvas is an SVG path from Lucide; no emoji are used. The thunder mark is an inline SVG with a green-to-blue gradient and no enclosing circle.
- **CDN static offload** is modelled as 35% of read traffic at the edge.
- **MTTR:** per-failure nominal durations from the spec are used as base values, then CI/CD (-60%), Monitoring (-3 s detection) and GitHub/Slack effects apply. The spec's "base 20 s" is a nominal recovery target; per-component durations are deliberately shorter/longer.
- **Tailwind** is the pinned Play CDN build, vendored for offline use; there is no production PostCSS build. The game's layout does not depend on Tailwind utilities being generated, so it remains usable if the Tailwind script is blocked.
- **Vendor files** are copies of pinned CDN releases; swap `<script src>` values in `index.html` for live CDN URLs if preferred.
