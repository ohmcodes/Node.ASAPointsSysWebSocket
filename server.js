const WebSocket = require('ws');
const mysql = require('mysql2/promise');
require('dotenv').config();

const WS_PORT = process.env.WS_PORT || 8080;
const WS_TOKEN = process.env.WS_TOKEN || null;

// If a player hasn't been re-confirmed by the mod within this window,
// they're considered offline (protects against mod crashes).
const PLAYER_STALE_MINUTES = Number(process.env.PLAYER_STALE_MINUTES) || 5;

// ---------- Auth ----------
function isAuthorized(req) {
  if (!WS_TOKEN) return true;
  const headerToken =
    req.headers['x-auth-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return headerToken === WS_TOKEN;
}

// ---------- Global state ----------
// activeJobs: connId -> { timer, cfg, players: Map<eosId, {group, lastSeen}> }
const activeJobs = new Map();
// poolCache: dbKey -> mysql pool
const poolCache = new Map();
let connectionCount = 0;

// ---------- Helpers ----------
function getPool(cfg) {
  const key = `${cfg.mysql.host}:${cfg.mysql.port}/${cfg.mysql.database}/${cfg.mysql.user}`;
  if (!poolCache.has(key)) {
    const p = mysql.createPool({
      ...cfg.mysql,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    });
    poolCache.set(key, p);
    console.log(`[DB] Created pool for ${key}`);
  }
  return poolCache.get(key);
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) {}
}

function nowIso() {
  return new Date().toISOString();
}

// Remove players not re-confirmed within PLAYER_STALE_MINUTES
function pruneStalePlayers(job) {
  const cutoff = Date.now() - PLAYER_STALE_MINUTES * 60 * 1000;
  let removed = 0;
  for (const [eosId, info] of job.players) {
    if (info.lastSeen < cutoff) {
      job.players.delete(eosId);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[Cache] Pruned ${removed} stale player(s). Remaining: ${job.players.size}`);
  }
}

// ---------- Config ----------
function normalizeConfig(raw) {
  const m = raw.mysql || {};
  const t = raw.tables || {};

  // permissionPlans: { "Default": { points: 10, intervalMinutes: 30 }, "VIP": {...} }
  const permissionPlans = raw.permissionPlans || {
    Default: { points: 10, intervalMinutes: 30 },
    VIP: { points: 25, intervalMinutes: 15 },
    Admin: { points: 100, intervalMinutes: 5 }
  };

  // Validate plans
  for (const [name, plan] of Object.entries(permissionPlans)) {
    if (typeof plan.points !== 'number' || plan.points < 0) {
      throw new Error(`permissionPlans["${name}"].points must be a non-negative number`);
    }
    if (typeof plan.intervalMinutes !== 'number' || plan.intervalMinutes <= 0) {
      throw new Error(`permissionPlans["${name}"].intervalMinutes must be > 0`);
    }
  }

  const cfg = {
    mysql: {
      host: m.host || process.env.DB_HOST || '127.0.0.1',
      port: m.port || Number(process.env.DB_PORT) || 3306,
      user: m.user || process.env.DB_USER,
      password: m.password || process.env.DB_PASSWORD,
      database: m.database || process.env.DB_DATABASE,
      connectionLimit: 5
    },
    tables: {
      playersTable: t.playersTable || 'ArkShopPlayers',
      playersPointsColumn: t.playersPointsColumn || 'Points',
      playersEosColumn: t.playersEosColumn || 'EosId',
      permissionGroupsTable: t.permissionGroupsTable || 'PermissionGroups',
      permissionGroupsNameColumn: t.permissionGroupsNameColumn || 'GroupName',
      permissionGroupsPermsColumn: t.permissionGroupsPermsColumn || 'Permissions',
      playerPermsTable: t.playerPermsTable || 'Players',
      playerPermsEosColumn: t.playerPermsEosColumn || 'EOS_Id',
      playerPermsGroupColumn: t.playerPermsGroupColumn || 'PermissionsGroups'
    },
    permissionPlans,
    defaultPermission: raw.defaultPermission || 'Default'
  };

  if (!cfg.mysql.user || !cfg.mysql.database) {
    throw new Error('mysql.user and mysql.database are required');
  }

  for (const [k, v] of Object.entries(cfg.tables)) {
    if (!/^[A-Za-z0-9_]+$/.test(v)) {
      throw new Error(`Invalid identifier for ${k}: ${v}`);
    }
  }

  return cfg;
}

async function testConnection(cfg) {
  const conn = await mysql.createConnection({
    host: cfg.mysql.host,
    port: cfg.mysql.port,
    user: cfg.mysql.user,
    password: cfg.mysql.password,
    database: cfg.mysql.database
  });
  await conn.ping();
  await conn.end();
}

async function ensureSchema(cfg) {
  const {
    playersTable, playersPointsColumn, playersEosColumn,
    permissionGroupsTable, permissionGroupsNameColumn, permissionGroupsPermsColumn,
    playerPermsTable, playerPermsEosColumn, playerPermsGroupColumn
  } = cfg.tables;

  const ddl = [
    `CREATE TABLE IF NOT EXISTS \`${playersTable}\` (
      \`Id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`${playersEosColumn}\` VARCHAR(64) NOT NULL UNIQUE,
      \`Kits\` TEXT NULL,
      \`${playersPointsColumn}\` INT NOT NULL DEFAULT 0,
      \`TotalSpent\` INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS \`${permissionGroupsTable}\` (
      \`Id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`${permissionGroupsNameColumn}\` VARCHAR(64) NOT NULL UNIQUE,
      \`${permissionGroupsPermsColumn}\` TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    `CREATE TABLE IF NOT EXISTS \`${playerPermsTable}\` (
      \`Id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`${playerPermsEosColumn}\` VARCHAR(64) NOT NULL UNIQUE,
      \`${playerPermsGroupColumn}\` VARCHAR(64) NULL,
      \`TimePermissionGroups\` DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  ];

  const conn = await mysql.createConnection({
    host: cfg.mysql.host,
    port: cfg.mysql.port,
    user: cfg.mysql.user,
    password: cfg.mysql.password,
    database: cfg.mysql.database
  });

  try {
    for (const stmt of ddl) await conn.query(stmt);

    const [rows] = await conn.query(
      `SELECT COUNT(*) AS c FROM \`${permissionGroupsTable}\``
    );
    if (rows[0].c === 0) {
      await conn.query(
        `INSERT INTO \`${permissionGroupsTable}\`
         (\`${permissionGroupsNameColumn}\`, \`${permissionGroupsPermsColumn}\`)
         VALUES ('Default', '')`
      );
      console.log('[Schema] Seeded Default group.');
    }
  } finally {
    await conn.end();
  }
}

// ---------- Job management ----------
function startAwardLoop(connId, cfg, ws) {
  const job = activeJobs.get(connId);
  // The loop ticks every MINUTE and checks per-player elapsed time.
  // This lets different permission groups have different intervals in one job.
  const tickMs = 60 * 1000; // 1 minute heartbeat

  job.timer = setInterval(async () => {
    try {
      await tickAwards(connId, ws);
    } catch (e) {
      console.error(`[Award] Tick failed (${connId}):`, e.message);
      safeSend(ws, { type: 'error', message: `Award tick failed: ${e.message}` });
    }
  }, tickMs);

  return job;
}

function stopJob(connId) {
  const job = activeJobs.get(connId);
  if (job) {
    if (job.timer) clearInterval(job.timer);
    activeJobs.delete(connId);
    console.log(`[Job] Stopped and removed job for ${connId}`);
  }
}

// ---------- Online / offline handling ----------
function upsertOnlinePlayer(job, eosId, group) {
  const g = (group || job.cfg.defaultPermission || 'Default').trim();
  const existing = job.players.get(eosId);
  if (existing) {
    // If the group changed, reset the timer so the new group's plan applies cleanly
    if (existing.group !== g) {
      existing.group = g;
      existing.lastAwardedAt = Date.now();
    }
    existing.lastSeen = Date.now();
  } else {
    job.players.set(eosId, {
      group: g,
      lastSeen: Date.now(),
      lastAwardedAt: Date.now() // start counting from now
    });
  }
}

function removeOfflinePlayer(job, eosId) {
  return job.players.delete(eosId);
}

// ---------- Core tick ----------
async function tickAwards(connId, ws) {
  const job = activeJobs.get(connId);
  if (!job) return;

  // Prune players the mod hasn't confirmed recently
  pruneStalePlayers(job);

  if (job.players.size === 0) {
    // No one online — skip silently
    return;
  }

  const pool = getPool(job.cfg);
  const now = Date.now();

  // Build list of players that are due for an award based on their group's interval
  const due = [];
  for (const [eosId, info] of job.players) {
    const plan = job.cfg.permissionPlans[info.group]
      || job.cfg.permissionPlans[job.cfg.defaultPermission]
      || { points: 0, intervalMinutes: 30 };

    const intervalMs = plan.intervalMinutes * 60 * 1000;
    if (now - info.lastAwardedAt >= intervalMs) {
      due.push({ eosId, group: info.group, points: plan.points });
    }
  }

  if (due.length === 0) return; // nothing due yet

  // Filter to players that actually exist in ArkShopPlayers
  const {
    playersTable, playersPointsColumn, playersEosColumn
  } = job.cfg.tables;

  const eosIds = due.map(d => d.eosId);
  const placeholders = eosIds.map(() => '?').join(',');
  const [existing] = await pool.query(
    `SELECT \`${playersEosColumn}\` AS eosId
     FROM \`${playersTable}\`
     WHERE \`${playersEosColumn}\` IN (${placeholders})`,
    eosIds
  );
  const existingSet = new Set(existing.map(r => r.eosId));
  const finalAwards = due.filter(d => existingSet.has(d.eosId));

  // Missing players — create them automatically so future ticks work
  const missing = due.filter(d => !existingSet.has(d.eosId));
  if (missing.length > 0) {
    const insertValues = missing.map(d => [d.eosId, 0, 0]);
    await pool.query(
      `INSERT IGNORE INTO \`${playersTable}\`
       (\`${playersEosColumn}\`, \`${playersPointsColumn}\`, \`TotalSpent\`)
       VALUES ?`,
      [insertValues]
    );
    // Include them in the award round
    finalAwards.push(...missing);
  }

  if (finalAwards.length === 0) return;

  // Apply updates
  const conn = await pool.getConnection();
  let totalAwarded = 0;
  const perPlayer = [];
  try {
    await conn.beginTransaction();
    for (const a of finalAwards) {
      const [res] = await conn.query(
        `UPDATE \`${playersTable}\`
         SET \`${playersPointsColumn}\` = \`${playersPointsColumn}\` + ?
         WHERE \`${playersEosColumn}\` = ?`,
        [a.points, a.eosId]
      );
      if (res.affectedRows > 0) {
        totalAwarded += a.points;
        perPlayer.push({ eosId: a.eosId, group: a.group, points: a.points });
        // Mark awarded in cache
        const info = job.players.get(a.eosId);
        if (info) info.lastAwardedAt = now;
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  if (perPlayer.length > 0) {
    safeSend(ws, {
      type: 'award',
      timestamp: nowIso(),
      awardedPlayers: perPlayer.length,
      totalPointsAwarded: totalAwarded,
      details: perPlayer
    });
    console.log(`[Award] ${connId}: awarded ${totalAwarded} pts to ${perPlayer.length} player(s).`);
  }
}

// ---------- WebSocket server ----------
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`[WS] Listening on port ${WS_PORT}`);
});

wss.on('connection', (ws, req) => {
  const serverName = req.headers['x-server-name'] || 'unknown';
  const connId = `${serverName}@${req.socket.remoteAddress}:${req.socket.remotePort}`;

  if (!isAuthorized(req)) {
    console.warn(`[WS] Unauthorized: ${connId}`);
    try { ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' })); } catch (_) {}
    ws.close(1008, 'Unauthorized');
    return;
  }

  connectionCount++;
  console.log(`[WS] Connected: ${connId} (total: ${connectionCount})`);

  // Each connection owns its own job state, created lazily on first "start"
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return safeSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    const action = (msg.action || '').toLowerCase();

    try {
      // ---------- start ----------
      if (action === 'start') {
        const cfg = normalizeConfig(msg.config || {});
        await testConnection(cfg);
        await ensureSchema(cfg);

        // If a job already exists, stop it and start fresh
        stopJob(connId);

        const job = {
          cfg,
          timer: null,
          players: new Map() // eosId -> { group, lastSeen, lastAwardedAt }
        };
        activeJobs.set(connId, job);
        startAwardLoop(connId, cfg, ws);

        safeSend(ws, {
          type: 'started',
          message: `Tracking online players. Tick every 1 minute; awards per group interval.`,
          permissionPlans: cfg.permissionPlans
        });
      }

      // ---------- stop ----------
      else if (action === 'stop') {
        stopJob(connId);
        safeSend(ws, { type: 'stopped' });
      }

      // ---------- status ----------
      else if (action === 'status') {
        const job = activeJobs.get(connId);
        safeSend(ws, {
          type: 'status',
          running: !!job,
          onlinePlayers: job ? job.players.size : 0,
          players: job
            ? Array.from(job.players.entries()).map(([eosId, i]) => ({
                eosId, group: i.group,
                lastSeenSecondsAgo: Math.round((Date.now() - i.lastSeen) / 1000),
                lastAwardedSecondsAgo: Math.round((Date.now() - i.lastAwardedAt) / 1000)
              }))
            : []
        });
      }

      // ---------- playerOnline ----------
      // Mod sends this when a player logs in OR periodically as a heartbeat.
      // { action: "playerOnline", players: [ { eosId, group }, ... ] }
      // OR single: { action: "playerOnline", eosId, group }
      else if (action === 'playeronline') {
        const job = activeJobs.get(connId);
        if (!job) return safeSend(ws, { type: 'error', message: 'Job not started. Send start first.' });

        const list = Array.isArray(msg.players)
          ? msg.players
          : (msg.eosId ? [{ eosId: msg.eosId, group: msg.group }] : []);

        if (list.length === 0) {
          return safeSend(ws, { type: 'error', message: 'No players provided.' });
        }

        let added = 0, refreshed = 0;
        for (const p of list) {
          if (!p.eosId) continue;
          const existed = job.players.has(p.eosId);
          upsertOnlinePlayer(job, p.eosId, p.group);
          existed ? refreshed++ : added++;
        }

        safeSend(ws, {
          type: 'playerOnlineAck',
          added, refreshed, totalOnline: job.players.size
        });
        console.log(`[Online] ${connId}: +${added} new, ~${refreshed} refreshed. Total=${job.players.size}`);
      }

      // ---------- playerOffline ----------
      // { action: "playerOffline", eosId: "..." }
      // OR { action: "playerOffline", players: ["eos1","eos2"] }
      else if (action === 'playeroffline') {
        const job = activeJobs.get(connId);
        if (!job) return safeSend(ws, { type: 'error', message: 'Job not started.' });

        const ids = Array.isArray(msg.players)
          ? msg.players
          : (msg.eosId ? [msg.eosId] : []);

        let removed = 0;
        for (const id of ids) {
          if (removeOfflinePlayer(job, id)) removed++;
        }

        safeSend(ws, {
          type: 'playerOfflineAck',
          removed, totalOnline: job.players.size
        });
        console.log(`[Offline] ${connId}: -${removed}. Total=${job.players.size}`);
      }

      // ---------- playerStatus ----------
      // Mod asks: "are these EOS ids still in your cache?"
      // { action: "playerStatus", players: ["eos1","eos2"] }
      else if (action === 'playerstatus') {
        const job = activeJobs.get(connId);
        if (!job) return safeSend(ws, { type: 'error', message: 'Job not started.' });

        const ids = Array.isArray(msg.players) ? msg.players : [];
        const result = ids.map(eosId => {
          const info = job.players.get(eosId);
          return {
            eosId,
            online: !!info,
            group: info ? info.group : null,
            lastSeenSecondsAgo: info ? Math.round((Date.now() - info.lastSeen) / 1000) : null
          };
        });
        safeSend(ws, { type: 'playerStatusResult', players: result });
      }

      // ---------- runOnce (manual trigger, ignores intervals) ----------
      else if (action === 'runonce') {
        const job = activeJobs.get(connId);
        if (!job) return safeSend(ws, { type: 'error', message: 'Job not started.' });

        // Force all online players to be due right now
        for (const info of job.players.values()) {
          info.lastAwardedAt = 0;
        }
        await tickAwards(connId, ws);
        safeSend(ws, { type: 'runonce-complete' });
      }

      else {
        safeSend(ws, { type: 'error', message: `Unknown action: ${action}` });
      }
    } catch (err) {
      console.error('[ERR]', err);
      safeSend(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    connectionCount--;
    console.log(`[WS] Disconnected: ${connId} (total: ${connectionCount})`);
    stopJob(connId);
  });

  ws.on('error', (err) => console.error(`[WS] Socket error (${connId}):`, err.message));
});

// ---------- Shutdown ----------
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  for (const [connId, job] of activeJobs) {
    if (job.timer) clearInterval(job.timer);
  }
  wss.close(() => process.exit(0));
});