/* ============================================================================
 * InfraGauntlet — data.js
 * Component catalog, 30-attack catalog, failure catalog, constants.
 * Plain classic script (works from file://) exposing window.IGData.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const TICK_MS = 500;
  const WAVES_PER_RUN = 30;
  const BASE_RPS = 100;
  const WAVE_GROWTH = 1.3;
  const START_BUDGET = 5;
  const LOW_AVAIL_MS = 15000;
  const OVER_BUDGET_MS = 30000;
  const TEST_SEED = 12345;

  /* ------------------------------------------------------------------ */
  /* COMPONENT CATALOG                                                   */
  /* Every node: id/type, label, icon, costPerHour, baseCapacityRPS,     */
  /* latencyMs, health, config{}, mitigations[], failureMode.            */
  /* ------------------------------------------------------------------ */
  const appTier = (cores) => {
    const ram = cores; // 1:1 core/GB tiers
    const cost = +(cores * 0.02 + ram * 0.005).toFixed(3);
    return {
      type: `app_${cores}c`,
      label: `App ${cores}c/${ram}GB`,
      short: `${cores}c`,
      category: 'compute',
      icon: 'server',
      color: '#22d3ee',
      costPerHour: cost,
      baseCapacityRPS: cores * 1500,
      latencyMs: 8,
      health: 100,
      config: { cores, ram },
      mitigations: [],
      failureMode: 'Process crash / bad deploy',
      description: `${cores} vCPU / ${ram}GB application tier. Capacity ${(cores * 1500).toLocaleString()} RPS.`,
    };
  };

  const COMPONENTS = {
    /* ---------------------------- EDGE / NETWORK ---------------------------- */
    internet: {
      type: 'internet', label: 'Internet', category: 'network', icon: 'globe',
      color: '#38bdf8', costPerHour: 0, baseCapacityRPS: Infinity, latencyMs: 0,
      health: 100, config: {}, mitigations: ['ddos'], failureMode: 'Upstream BGP / ISP issue',
      description: 'Source of all traffic. Free. Must be connected to the graph for traffic to flow.',
      source: true,
    },
    cdn: {
      type: 'cdn', label: 'CDN', category: 'network', icon: 'cloud',
      color: '#a78bfa', costPerHour: 0.18, baseCapacityRPS: 300000, latencyMs: 4,
      health: 100, config: {}, mitigations: ['ddos', 'http_flood', 'xss', 'bot_traffic', 'cache_poisoning', 'dns_poisoning', 'mitm'],
      failureMode: 'Edge POP outage / stale cache',
      description: 'Absorbs static reads at the edge and sheds volumetric traffic. Static offload = 35% of reads.',
      staticOffload: 0.35,
    },
    lb: {
      type: 'lb', label: 'Load Balancer', category: 'network', icon: 'network',
      color: '#60a5fa', costPerHour: 0.12, baseCapacityRPS: 500000, latencyMs: 2,
      health: 100, config: {}, mitigations: ['ddos', 'dos', 'syn_flood', 'slowloris', 'http_flood', 'credential_stuffing', 'api_abuse', 'enumeration'],
      failureMode: 'Health-check storm / config push',
      description: 'Round-robin across app servers, health checks, connection timeouts and rate limiting.',
    },
    nat: {
      type: 'nat', label: 'NAT Gateway', category: 'network', icon: 'arrow-right-left',
      color: '#818cf8', costPerHour: 0.09, baseCapacityRPS: 250000, latencyMs: 2,
      health: 100, config: {}, mitigations: ['udp_amp', 'ssrf', 'data_exfil'],
      failureMode: 'Port exhaustion',
      description: 'Outbound-only egress. Keeps internal services unreachable from the internet.',
    },
    apigw: {
      type: 'apigw', label: 'API Gateway', category: 'network', icon: 'signpost',
      color: '#38bdf8', costPerHour: 0.10, baseCapacityRPS: 180000, latencyMs: 3,
      health: 100, config: {}, mitigations: ['slowloris', 'csrf', 'ssrf', 'xxe', 'deserialization', 'replay', 'api_abuse', 'bot_traffic', 'enumeration'],
      failureMode: 'Throttle misconfiguration',
      description: 'AuthN/Z, rate limits, schemas, request validation and nonce checks.',
    },
    waf: {
      type: 'waf', label: 'Firewall / WAF', category: 'network', icon: 'shield',
      color: '#f59e0b', costPerHour: 0.15, baseCapacityRPS: 220000, latencyMs: 1,
      health: 100, config: {}, mitigations: ['dos', 'syn_flood', 'http_flood', 'sqli', 'xss', 'path_traversal', 'cmd_injection', 'deserialization', 'bot_traffic', 'enumeration'],
      failureMode: 'Rule false-positive outage',
      description: 'Deep packet / L7 inspection. Blocks SQLi, XSS, CSRF payloads, path traversal and RCE patterns.',
    },
    shield: {
      type: 'shield', label: 'DDoS Shield', category: 'network', icon: 'shield-check',
      color: '#e879f9', costPerHour: 0.25, baseCapacityRPS: 1000000, latencyMs: 0,
      health: 100, config: {}, mitigations: ['ddos', 'udp_amp', 'bgp_hijack'],
      failureMode: 'Scrubbing center reroute',
      description: 'Anycast scrubbing centers absorb volumetric floods before they reach origin.',
    },

    /* ------------------------------ COMPUTE -------------------------------- */
    app_1c: appTier(1), app_2c: appTier(2), app_4c: appTier(4), app_8c: appTier(8),
    app_16c: appTier(16), app_32c: appTier(32), app_64c: appTier(64), app_128c: appTier(128),
    app_custom: {
      type: 'app_custom', label: 'Custom App Server', short: 'Custom', category: 'compute',
      icon: 'cpu', color: '#22d3ee', costPerHour: 0.10,
      baseCapacityRPS: 6000, latencyMs: 8, health: 100,
      config: { cores: 4, ram: 8 }, custom: true, mitigations: [],
      failureMode: 'Process crash / bad deploy',
      description: 'Size your own app server: 1–128 vCPU, 1–512GB RAM, linear cost & capacity.',
    },

    /* ------------------------------- CACHE --------------------------------- */
    redis: {
      type: 'redis', label: 'Redis Cache', category: 'cache', icon: 'zap',
      color: '#f87171', costPerHour: 0.06, baseCapacityRPS: 30000, latencyMs: 1,
      health: 100, config: {}, mitigations: ['cache_poisoning'],
      failureMode: 'Cache stampede / eviction storm',
      description: 'Read cache, session store and rate-limit counter. Serves reads without touching the DB.',
    },

    /* ----------------------------- DATABASES ------------------------------- */
    mysql: {
      type: 'mysql', label: 'MySQL', category: 'database', icon: 'database',
      color: '#f59e0b', costPerHour: 0.22, baseCapacityRPS: 8000, baseReadRPS: 8000,
      baseWriteRPS: 3000, latencyMs: 12, health: 100,
      config: { shards: 1, replicas: 0, sharded: false },
      mitigations: [], failureMode: 'Primary failover / lock storm',
      description: 'Write-heavy relational DB. Supports sharding and read replicas.',
    },
    postgres: {
      type: 'postgres', label: 'PostgreSQL', category: 'database', icon: 'database',
      color: '#60a5fa', costPerHour: 0.24, baseCapacityRPS: 8500, baseReadRPS: 8500,
      baseWriteRPS: 3200, latencyMs: 12, health: 100,
      config: { shards: 1, replicas: 0, sharded: false },
      mitigations: [], failureMode: 'Primary failover / WAL replay',
      description: 'Transactional relational DB with JSON support. Supports sharding and read replicas.',
    },
    mongodb: {
      type: 'mongodb', label: 'MongoDB', category: 'database', icon: 'leaf',
      color: '#4ade80', costPerHour: 0.20, baseCapacityRPS: 9000, baseReadRPS: 9000,
      baseWriteRPS: 4000, latencyMs: 11, health: 100,
      config: { shards: 1, replicas: 0, sharded: false },
      mitigations: [], failureMode: 'Shard rebalance / election',
      description: 'Document DB, horizontal sharding. Supports sharding and read replicas.',
    },
    replica: {
      type: 'replica', label: 'Read Replica', category: 'database', icon: 'copy',
      color: '#93c5fd', costPerHour: 0.08, baseCapacityRPS: 12000, baseReadRPS: 12000,
      baseWriteRPS: 0, latencyMs: 15, health: 100,
      config: { attachedTo: null }, mitigations: [], failureMode: 'Replication lag',
      description: 'Standalone read replica. Connect it like any node to offload reads from a primary.',
    },

    /* --------------------------- QUEUES / STREAMING ------------------------ */
    kafka: {
      type: 'kafka', label: 'Kafka', category: 'queue', icon: 'radio',
      color: '#fbbf24', costPerHour: 0.16, baseCapacityRPS: 40000, latencyMs: 3,
      health: 100, config: { partitions: 6, replicas: 2 }, bufferRPS: 40000, maxBacklogSeconds: 8,
      mitigations: [], failureMode: 'Partition leader election',
      description: 'High-throughput event streaming. Buffers load so DB outages create backpressure, not instant errors.',
    },
    rabbitmq: {
      type: 'rabbitmq', label: 'RabbitMQ', category: 'queue', icon: 'workflow',
      color: '#fb923c', costPerHour: 0.09, baseCapacityRPS: 12000, latencyMs: 4,
      health: 100, config: { queues: 4, deadLetter: true }, bufferRPS: 12000, maxBacklogSeconds: 6,
      mitigations: [], failureMode: 'Queue memory alarm',
      description: 'Task queues, pub/sub and dead-letter queues. Buffers overflow with backpressure.',
    },

    /* ------------------------------ STORAGE -------------------------------- */
    s3: {
      type: 's3', label: 'S3 Object Storage', category: 'storage', icon: 'archive',
      color: '#34d399', costPerHour: 0.05, baseCapacityRPS: 60000, baseReadRPS: 60000,
      baseWriteRPS: 15000, latencyMs: 6, health: 100, config: {},
      mitigations: [], failureMode: 'Throttling / 503 SlowDown',
      description: 'Static assets, uploads, backups. Ransomware recovery depends on S3 + CI/CD.',
    },

    /* ------------------------------ DEVOPS --------------------------------- */
    github: {
      type: 'github', label: 'GitHub', category: 'devops', icon: 'git-branch',
      color: '#e2e8f0', costPerHour: 0.03, baseCapacityRPS: 1e9, latencyMs: 0,
      health: 100, config: {}, mitigations: ['zero_day'],
      failureMode: 'Source of truth unavailable',
      description: 'Source of truth. Enables rollback after a failed deploy (prevents data loss).',
    },
    cicd: {
      type: 'cicd', label: 'CI/CD Pipeline', category: 'devops', icon: 'git-pull-request',
      color: '#a3e635', costPerHour: 0.08, baseCapacityRPS: 1e9, latencyMs: 0,
      health: 100, config: {}, mitigations: ['zero_day', 'ransomware'],
      failureMode: 'Failed pipeline / stuck deploy',
      description: 'GitHub Actions. Auto-heals failed nodes and cuts MTTR by 60%.',
    },
    slack: {
      type: 'slack', label: 'Slack Alerts', category: 'devops', icon: 'bell',
      color: '#f472b6', costPerHour: 0.02, baseCapacityRPS: 1e9, latencyMs: 0,
      health: 100, config: {}, mitigations: ['brute_force', 'insider'],
      failureMode: 'Alert fatigue / missed page',
      description: 'Pages humans. Preserves 10% more reputation by warning the team faster.',
    },
    monitoring: {
      type: 'monitoring', label: 'Monitoring', category: 'devops', icon: 'activity',
      color: '#34d399', costPerHour: 0.06, baseCapacityRPS: 1e9, latencyMs: 0,
      health: 100, config: {}, mitigations: ['zero_day', 'insider', 'data_exfil', 'dns_poisoning', 'bgp_hijack'],
      failureMode: 'Blind spots / metric cardinality',
      description: 'Prometheus + Grafana. Detects failures 3s earlier and reduces blind spots.',
    },

    /* ------------------------------ SECURITY ------------------------------- */
    auth: {
      type: 'auth', label: 'Auth Service', category: 'security', icon: 'key-round',
      color: '#facc15', costPerHour: 0.07, baseCapacityRPS: 100000, latencyMs: 2,
      health: 100, config: {}, mitigations: ['credential_stuffing', 'brute_force', 'session_hijack', 'jwt_forgery', 'csrf', 'xss', 'mitm'],
      failureMode: 'Token signing key rotation',
      description: 'JWT / OAuth. Blocks credential stuffing, token forgery and session theft.',
    },
    vault: {
      type: 'vault', label: 'Secrets Vault', category: 'security', icon: 'lock',
      color: '#c084fc', costPerHour: 0.05, baseCapacityRPS: 1e9, latencyMs: 0,
      health: 100, config: {}, mitigations: ['cmd_injection', 'jwt_forgery', 'insider'],
      failureMode: 'Seal / unseal outage',
      description: 'Isolates keys and secrets. Blocks insider theft and JWT forgery.',
    },
    ids: {
      type: 'ids', label: 'IDS / IPS', category: 'security', icon: 'bug',
      color: '#fb7185', costPerHour: 0.08, baseCapacityRPS: 1e9, latencyMs: 0,
      health: 100, config: {}, mitigations: ['zero_day', 'syn_flood', 'data_exfil'],
      failureMode: 'Signature miss / false positive',
      description: 'Detects intrusion attempts and blocks known exploit signatures.',
    },
  };

  /* ------------------------------------------------------------------ */
  /* ATTACK CATALOG — 30 attacks                                         */
  /* Fields: id,name,icon,category,waveMultiplier,maliciousRatio,        */
  /* targetLayer,mitigations[],effectIfUnmitigated,effectIfMitigated,   */
  /* teach,repDamage,errorRate,target                            */
  /* ------------------------------------------------------------------ */
  const ATTACKS = [
    /* ---- VOLUMETRIC / NETWORK ---- */
    {
      id: 'ddos', name: 'DDoS (Volumetric)', icon: 'waves', category: 'network', waveMultiplier: 10,
      maliciousRatio: 0.98, targetLayer: 'edge', repDamage: 9, errorRate: 0.02, target: 'edge',
      mitigations: ['shield', 'cdn', 'lb'],
      effectIfUnmitigated: '10× junk traffic floods the edge; availability collapses and reputation bleeds.',
      effectIfMitigated: 'Scrubbing + edge absorption caps the flood before origin.',
      teach: 'Volumetric DDoS saturates bandwidth. Anycast + scrubbing centers absorb it at the edge; a CDN also serves cached static traffic without touching origin.',
    },
    {
      id: 'dos', name: 'DoS (Single Source)', icon: 'user-x', category: 'network', waveMultiplier: 3,
      maliciousRatio: 0.9, targetLayer: 'edge', repDamage: 4, errorRate: 0.03, target: 'edge',
      mitigations: ['waf', 'lb'],
      effectIfUnmitigated: 'A single mean IP drives 3× traffic and exhausts connections.',
      effectIfMitigated: 'WAF + LB rate limits drop the source before it reaches app workers.',
      teach: 'A DoS is one source; rate limiting and IP reputation at the WAF/LB are cheap, effective mitigations.',
    },
    {
      id: 'syn_flood', name: 'SYN Flood', icon: 'git-commit-horizontal', category: 'network', waveMultiplier: 2.5,
      maliciousRatio: 0.95, targetLayer: 'edge', repDamage: 5, errorRate: 0.05, target: 'lb',
      mitigations: ['waf', 'lb'],
      effectIfUnmitigated: 'Half-open connections exhaust the load balancer connection table.',
      effectIfMitigated: 'SYN cookies and proxy timeouts preserve connection capacity.',
      teach: 'SYN floods never finish the TCP handshake. SYN cookies and terminating TCP at the LB protect backends.',
    },
    {
      id: 'udp_amp', name: 'UDP Amplification', icon: 'radio-tower', category: 'network', waveMultiplier: 20,
      maliciousRatio: 0.99, targetLayer: 'edge', repDamage: 10, errorRate: 0.02, target: 'edge',
      mitigations: ['shield', 'nat'],
      effectIfUnmitigated: 'Spoofed UDP floods saturate ingress; 20× packets for every request.',
      effectIfMitigated: 'Anycast scrubbing drops the amplified flood; NAT hides internal targets.',
      teach: 'UDP amplification abuses open resolvers. Scrubbing centers and ingress filtering absorb it.',
    },
    {
      id: 'slowloris', name: 'Slowloris', icon: 'snail', category: 'network', waveMultiplier: 1.15,
      maliciousRatio: 0.2, targetLayer: 'edge', repDamage: 3, errorRate: 0.28, target: 'lb',
      mitigations: ['lb', 'apigw'],
      effectIfUnmitigated: 'Slow requests pin app workers open; latency and 5xx rise.',
      effectIfMitigated: 'LB timeouts and API Gateway request limits close the sockets.',
      teach: 'Slowloris keeps many connections open with partial requests. Aggressive timeouts and connection limits are the fix.',
    },
    {
      id: 'http_flood', name: 'HTTP Flood', icon: 'waves', category: 'network', waveMultiplier: 6,
      maliciousRatio: 0.9, targetLayer: 'app', repDamage: 5, errorRate: 0.08, target: 'app',
      mitigations: ['waf', 'cdn', 'lb'],
      effectIfUnmitigated: 'Valid-looking GETs bypass naive filters and hammer app workers.',
      effectIfMitigated: 'WAF behaviour rules, CDN caching and LB rate limits absorb the flood.',
      teach: 'HTTP floods look legitimate. Layer 7 fingerprints plus per-IP and per-session rate limits are required.',
    },

    /* ---- APPLICATION LAYER ---- */
    {
      id: 'sqli', name: 'SQL Injection', icon: 'database-zap', category: 'application', waveMultiplier: 1.2,
      maliciousRatio: 0.3, targetLayer: 'app', repDamage: 8, errorRate: 0.45, target: 'db',
      mitigations: ['waf', 'apigw'],
      effectIfUnmitigated: 'DB writes are corrupted; errors spike and availability drops.',
      effectIfMitigated: 'WAF signatures and API Gateway parameterized inputs block the payload.',
      teach: 'Never concatenate SQL. Parameterized queries plus WAF signatures defend in depth.',
    },
    {
      id: 'xss', name: 'XSS', icon: 'code-2', category: 'application', waveMultiplier: 1.15,
      maliciousRatio: 0.2, targetLayer: 'app', repDamage: 7, errorRate: 0.12, target: 'app',
      mitigations: ['waf', 'cdn', 'auth'],
      effectIfUnmitigated: 'User sessions are stolen; trust and reputation take a hit.',
      effectIfMitigated: 'WAF filters scripts; CDN sanitizes; Auth rotates exposed sessions.',
      teach: 'XSS executes attacker script in users’ browsers. Output encoding, CSP and WAF rules reduce risk.',
    },
    {
      id: 'csrf', name: 'CSRF', icon: 'mouse-pointer-click', category: 'application', waveMultiplier: 1.1,
      maliciousRatio: 0.2, targetLayer: 'app', repDamage: 6, errorRate: 0.1, target: 'app',
      mitigations: ['auth', 'apigw'],
      effectIfUnmitigated: 'Unauthorized state changes are accepted as the victim.',
      effectIfMitigated: 'CSRF tokens and SameSite auth cookies reject forged requests.',
      teach: 'CSRF abuses a logged-in browser. Anti-CSRF tokens and SameSite cookies stop it.',
    },
    {
      id: 'ssrf', name: 'SSRF', icon: 'route', category: 'application', waveMultiplier: 1.3,
      maliciousRatio: 0.5, targetLayer: 'app', repDamage: 7, errorRate: 0.18, target: 'app',
      mitigations: ['nat', 'waf', 'apigw'],
      effectIfUnmitigated: 'Attacker reaches internal services through the app and exfiltrates data.',
      effectIfMitigated: 'NAT egress controls and API Gateway allow-lists keep internal services private.',
      teach: 'SSRF tricks the server into fetching internal URLs. Egress allow-lists and metadata blocks are essential.',
    },
    {
      id: 'xxe', name: 'XXE (XML External Entity)', icon: 'file-code-2', category: 'application', waveMultiplier: 1.2,
      maliciousRatio: 0.4, targetLayer: 'app', repDamage: 6, errorRate: 0.2, target: 'app',
      mitigations: ['apigw', 'waf'],
      effectIfUnmitigated: 'XML parser reads local files and exfiltrates secrets.',
      effectIfMitigated: 'External entity resolution disabled at the gateway; WAF blocks payloads.',
      teach: 'Disable DTDs / external entities in XML parsers. Input validation at the gateway helps too.',
    },
    {
      id: 'path_traversal', name: 'Path Traversal', icon: 'folder-search', category: 'application', waveMultiplier: 1.2,
      maliciousRatio: 0.3, targetLayer: 'app', repDamage: 5, errorRate: 0.18, target: 'app',
      mitigations: ['waf', 'app'],
      effectIfUnmitigated: 'Malicious paths read files outside the web root.',
      effectIfMitigated: 'WAF normalizes paths and app hardening enforces the web root.',
      teach: 'Canonicalize and allow-list file paths. Never trust user-supplied ../ sequences.',
    },
    {
      id: 'cmd_injection', name: 'Command Injection', icon: 'terminal-square', category: 'application', waveMultiplier: 1.4,
      maliciousRatio: 0.5, targetLayer: 'app', repDamage: 9, errorRate: 0.3, target: 'app',
      mitigations: ['waf', 'vault'],
      effectIfUnmitigated: 'Remote code execution attempt; credentials are at risk.',
      effectIfMitigated: 'WAF blocks shell metacharacters; Vault isolation limits stolen credentials.',
      teach: 'Never pass user input to a shell. Use safe APIs; isolate secrets in a vault.',
    },
    {
      id: 'deserialization', name: 'Deserialization Attack', icon: 'package-open', category: 'application', waveMultiplier: 1.3,
      maliciousRatio: 0.4, targetLayer: 'app', repDamage: 8, errorRate: 0.25, target: 'app',
      mitigations: ['apigw', 'waf'],
      effectIfUnmitigated: 'A gadget chain turns untrusted input into remote code execution.',
      effectIfMitigated: 'Gateway schema validation rejects unexpected serialized shapes; WAF blocks signatures.',
      teach: 'Avoid native object deserialization of untrusted data. Validate schemas and use safe formats.',
    },

    /* ---- AUTH / SESSION ---- */
    {
      id: 'credential_stuffing', name: 'Credential Stuffing', icon: 'users', category: 'auth', waveMultiplier: 1.8,
      maliciousRatio: 0.5, targetLayer: 'auth', repDamage: 6, errorRate: 0.12, target: 'auth',
      mitigations: ['auth', 'lb'],
      effectIfUnmitigated: 'Leaked credential lists trigger mass account takeovers.',
      effectIfMitigated: 'Auth rate limits and MFA checks stop the login spray.',
      teach: 'Credential stuffing replays leaked passwords. MFA, breached-password checks and rate limiting reduce it.',
    },
    {
      id: 'brute_force', name: 'Brute Force', icon: 'lock-keyhole', category: 'auth', waveMultiplier: 1.6,
      maliciousRatio: 0.4, targetLayer: 'auth', repDamage: 4, errorRate: 0.1, target: 'auth',
      mitigations: ['auth', 'slack'],
      effectIfUnmitigated: 'Password guessing burns login capacity and locks accounts.',
      effectIfMitigated: 'Auth throttling plus fast Slack alerts shut the attempt down.',
      teach: 'Throttle authentication, add exponential backoff, and page the on-call early.',
    },
    {
      id: 'session_hijack', name: 'Session Hijacking', icon: 'user-round-x', category: 'auth', waveMultiplier: 1.1,
      maliciousRatio: 0.2, targetLayer: 'auth', repDamage: 7, errorRate: 0.08, target: 'auth',
      mitigations: ['auth', 'cdn'],
      effectIfUnmitigated: 'Stolen cookies are replayed and users lose their sessions.',
      effectIfMitigated: 'Rotating tokens and HTTPS at the CDN invalidate the stolen session.',
      teach: 'Short-lived rotating tokens, HTTPS everywhere and device binding limit session theft.',
    },
    {
      id: 'jwt_forgery', name: 'JWT Forgery', icon: 'file-key', category: 'auth', waveMultiplier: 1.2,
      maliciousRatio: 0.3, targetLayer: 'auth', repDamage: 6, errorRate: 0.12, target: 'auth',
      mitigations: ['vault', 'auth'],
      effectIfUnmitigated: 'Attacker-crafted tokens are accepted as valid users.',
      effectIfMitigated: 'Vault-held signing keys and strict token verification reject forged JWTs.',
      teach: 'Never trust alg:none. Verify signatures with keys stored outside the app.',
    },
    {
      id: 'replay', name: 'Replay Attack', icon: 'repeat-2', category: 'auth', waveMultiplier: 1.2,
      maliciousRatio: 0.2, targetLayer: 'auth', repDamage: 5, errorRate: 0.08, target: 'auth',
      mitigations: ['apigw', 'auth'],
      effectIfUnmitigated: 'Captured state-changing requests are replayed.',
      effectIfMitigated: 'Gateway nonce and timestamp checks make replays fail.',
      teach: 'Nonces, timestamps and idempotency keys defeat replay attacks.',
    },
    {
      id: 'api_abuse', name: 'API Abuse / Rate-limit Bypass', icon: 'gauge', category: 'auth', waveMultiplier: 2.5,
      maliciousRatio: 0.6, targetLayer: 'app', repDamage: 5, errorRate: 0.1, target: 'app',
      mitigations: ['apigw', 'cdn', 'lb'],
      effectIfUnmitigated: 'Scrapers rotate IPs and bypass naive quotas, slowing real users.',
      effectIfMitigated: 'Distributed rate limits at CDN, gateway and LB enforce quotas.',
      teach: 'Rate limiting must be distributed and keyed by user/API key, not only by IP.',
    },

    /* ---- INFRASTRUCTURE / SUPPLY CHAIN ---- */
    {
      id: 'dns_poisoning', name: 'DNS Poisoning / Spoofing', icon: 'globe-lock', category: 'infrastructure', waveMultiplier: 1.5,
      maliciousRatio: 0.3, targetLayer: 'edge', repDamage: 7, errorRate: 0.18, target: 'edge',
      mitigations: ['cdn', 'monitoring'],
      effectIfUnmitigated: 'Traffic is misrouted to attacker-controlled endpoints.',
      effectIfMitigated: 'DNSSEC at the edge plus monitoring alerts catch route anomalies.',
      teach: 'DNSSEC, registry locks and DNS monitoring protect route integrity.',
    },
    {
      id: 'bgp_hijack', name: 'BGP Hijack', icon: 'waypoints', category: 'infrastructure', waveMultiplier: 2.0,
      maliciousRatio: 0.5, targetLayer: 'edge', repDamage: 9, errorRate: 0.15, target: 'edge',
      mitigations: ['shield', 'monitoring'],
      effectIfUnmitigated: 'Routes are hijacked and traffic leaves the legitimate network.',
      effectIfMitigated: 'Anycast scrubbing plus BGP monitoring limit the hijack window.',
      teach: 'BGP has no built-in authentication. RPKI, route monitoring and anycast reduce exposure.',
    },
    {
      id: 'cache_poisoning', name: 'Cache Poisoning', icon: 'skull', category: 'infrastructure', waveMultiplier: 1.4,
      maliciousRatio: 0.3, targetLayer: 'cache', repDamage: 6, errorRate: 0.2, target: 'cache',
      mitigations: ['redis', 'cdn'],
      effectIfUnmitigated: 'Malicious cache entries are served to every user.',
      effectIfMitigated: 'Signed cache keys and CDN cache-control validation reject poisoned entries.',
      teach: 'Segment cache keys, sign values, and purge on suspicion. Never cache unvalidated input.',
    },
    {
      id: 'mitm', name: 'MITM (Man-in-the-Middle)', icon: 'split', category: 'infrastructure', waveMultiplier: 1.3,
      maliciousRatio: 0.2, targetLayer: 'edge', repDamage: 8, errorRate: 0.12, target: 'edge',
      mitigations: ['cdn', 'auth'],
      effectIfUnmitigated: 'Traffic is intercepted and tampered with in transit.',
      effectIfMitigated: 'HTTPS end-to-end and auth token binding prevent interception.',
      teach: 'TLS everywhere, HSTS and certificate pinning defeat MITM.',
    },
    {
      id: 'zero_day', name: 'Zero-Day Exploit', icon: 'biohazard', category: 'infrastructure', waveMultiplier: 1.5,
      maliciousRatio: 0.4, targetLayer: 'app', repDamage: 8, errorRate: 0.22, target: 'random', forcedFailure: 'app_down',
      mitigations: ['monitoring', 'cicd', 'ids'],
      effectIfUnmitigated: 'A random node is compromised and taken down until a hotfix lands.',
      effectIfMitigated: 'Monitoring catches it early and CI/CD ships a hotfix, shortening the outage.',
      teach: 'You cannot patch an unknown bug, but observability and fast deploys reduce blast radius and downtime.',
    },
    {
      id: 'ransomware', name: 'Ransomware', icon: 'file-lock-2', category: 'infrastructure', waveMultiplier: 1.2,
      maliciousRatio: 0.3, targetLayer: 'db', repDamage: 10, errorRate: 0.3, target: 'db', forcedFailure: 'db_down',
      mitigations: ['s3', 'cicd'],
      effectIfUnmitigated: 'The database is encrypted; data is unavailable until restored.',
      effectIfMitigated: 'S3 backups plus a CI/CD restore path recover the data with bounded loss.',
      teach: 'Immutable backups and tested restore drills are the only reliable ransomware defense.',
    },
    {
      id: 'insider', name: 'Insider Threat', icon: 'user-round-x', category: 'infrastructure', waveMultiplier: 1.1,
      maliciousRatio: 0.1, targetLayer: 'app', repDamage: 7, errorRate: 0.06, target: 'app',
      mitigations: ['vault', 'monitoring', 'slack'],
      effectIfUnmitigated: 'An insider exfiltrates data with legitimate-looking access.',
      effectIfMitigated: 'Vault least-privilege, monitoring and Slack alerts contain the exfiltration.',
      teach: 'Least privilege, audit logs and anomaly alerts are key insider-threat controls.',
    },
    {
      id: 'data_exfil', name: 'Data Exfiltration', icon: 'database-backup', category: 'infrastructure', waveMultiplier: 1.4,
      maliciousRatio: 0.2, targetLayer: 'edge', repDamage: 8, errorRate: 0.08, target: 'edge',
      mitigations: ['nat', 'monitoring'],
      effectIfUnmitigated: 'Large outbound transfers leak customer data; egress cost spikes.',
      effectIfMitigated: 'NAT egress allow-lists and monitoring alerts contain the transfer.',
      teach: 'Restrict egress, baseline normal traffic, and alert on large transfers.',
    },
    {
      id: 'bot_traffic', name: 'Bot Traffic (Scrapers)', icon: 'bot', category: 'infrastructure', waveMultiplier: 2.0,
      maliciousRatio: 0.7, targetLayer: 'app', repDamage: 3, errorRate: 0.05, target: 'app',
      mitigations: ['waf', 'cdn', 'apigw'],
      effectIfUnmitigated: 'Scrapers and crawlers double RPS and steal content.',
      effectIfMitigated: 'WAF bot rules and CDN challenge pages filter non-human traffic.',
      teach: 'Bot management combines reputation, JS challenges and behavioural analysis — not just User-Agent checks.',
    },
    {
      id: 'enumeration', name: 'Enumeration Attack', icon: 'list-ordered', category: 'infrastructure', waveMultiplier: 1.8,
      maliciousRatio: 0.5, targetLayer: 'app', repDamage: 4, errorRate: 0.12, target: 'app',
      mitigations: ['apigw', 'lb', 'waf'],
      effectIfUnmitigated: 'Endpoint enumeration discovers and abuses hidden APIs.',
      effectIfMitigated: 'API Gateway schema validation and LB rate limits throttle enumeration.',
      teach: 'Disable verbose errors, use allow-listed routes, and rate limit by identity.',
    },
  ];

  /* ------------------------------------------------------------------ */
  /* FAILURE CATALOG                                                     */
  /* ------------------------------------------------------------------ */
  const FAILURES = [
    { id: 'db_down', name: 'Database Down', icon: 'database', category: 'database', durationMs: 14000, target: 'database',
      desc: 'Primary DB unavailable. Requests queue upstream or drop.', effect: 'DB writes/reads fail until failover.' },
    { id: 'app_down', name: 'App Server Down', icon: 'server-off', category: 'app', durationMs: 10000, target: 'app',
      desc: 'An app worker crashed or a bad deploy landed.', effect: 'App capacity is lost until repaired.' },
    { id: 'cache_down', name: 'Cache Down', icon: 'zap-off', category: 'cache', durationMs: 5000, target: 'cache',
      desc: 'Cache node unavailable; DB load spikes.', effect: 'Reads fall through to the DB.' },
    { id: 'queue_down', name: 'Queue Down', icon: 'wifi-off', category: 'queue', durationMs: 9000, target: 'queue',
      desc: 'Queue unavailable; app backpressure grows.', effect: 'No buffering; overflow drops.' },
    { id: 'lb_down', name: 'Load Balancer Down', icon: 'network', category: 'app', durationMs: 22000, target: 'lb',
      desc: 'LB outage; total ingress outage until CI/CD heals it.', effect: 'No traffic reaches app servers.' },
    { id: 'network_partition', name: 'Network Partition', icon: 'unplug', category: 'network', durationMs: 5000, target: 'network',
      desc: 'Edge cut for a few seconds.', effect: 'All ingress traffic is interrupted.' },
  ];

  const CATEGORIES = {
    network: { label: 'Network', icon: 'globe', color: '#38bdf8' },
    compute: { label: 'Compute', icon: 'server', color: '#22d3ee' },
    cache: { label: 'Cache', icon: 'zap', color: '#f87171' },
    database: { label: 'Databases', icon: 'database', color: '#60a5fa' },
    queue: { label: 'Queues / Streaming', icon: 'radio', color: '#fbbf24' },
    storage: { label: 'Storage', icon: 'archive', color: '#34d399' },
    devops: { label: 'DevOps', icon: 'git-branch', color: '#a3e635' },
    security: { label: 'Security', icon: 'shield', color: '#facc15' },
  };

  /* Palette ordering / visibility.  Compute tiers are rendered as one inline group. */
  const PALETTE = [
    { category: 'network', types: ['internet', 'cdn', 'lb', 'nat', 'apigw', 'waf', 'shield'] },
    { category: 'compute', types: ['app_1c', 'app_2c', 'app_4c', 'app_8c', 'app_16c', 'app_32c', 'app_64c', 'app_128c', 'app_custom'], compact: true },
    { category: 'cache', types: ['redis'] },
    { category: 'database', types: ['mysql', 'postgres', 'mongodb', 'replica'] },
    { category: 'queue', types: ['kafka', 'rabbitmq'] },
    { category: 'storage', types: ['s3'] },
    { category: 'devops', types: ['github', 'cicd', 'slack', 'monitoring'] },
    { category: 'security', types: ['auth', 'vault', 'ids'] },
  ];

  const ATTACK_BY_ID = Object.fromEntries(ATTACKS.map((a) => [a.id, a]));
  const FAILURE_BY_ID = Object.fromEntries(FAILURES.map((f) => [f.id, f]));
  const COMPONENT_BY_TYPE = COMPONENTS;

  const API = {
    TICK_MS, WAVES_PER_RUN, BASE_RPS, WAVE_GROWTH, START_BUDGET, LOW_AVAIL_MS,
    OVER_BUDGET_MS, TEST_SEED,
    COMPONENTS, COMPONENT_BY_TYPE, ATTACKS, ATTACK_BY_ID, FAILURES, FAILURE_BY_ID,
    CATEGORIES, PALETTE,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.IGData = API;
})(typeof window !== 'undefined' ? window : globalThis);

