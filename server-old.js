const WebSocket = require('ws');
const mysql = require('mysql2/promise');
require('dotenv').config();

const WS_PORT = process.env.WS_PORT || 8080;
const WS_TOKEN = process.env.WS_TOKEN || null;

function isAuthorized(req) {
  if (!WS_TOKEN) return true; // auth disabled

  // Accept from either header
  const headerToken =
    req.headers['x-auth-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  return headerToken === WS_TOKEN;
}

// Store active point-awarding jobs keyed by connection id
const activeJobs = new Map();

/**
 * Expected message format from requester:
 * {
 *   "action": "start",
 *   "config": {
 *     "mysql": {
 *       "host": "127.0.0.1",
 *       "port": 3306,
 *       "user": "root",
 *       "password": "secret",
 *       "database": "arkshop"
 *     },
 *     "tables": {
 *       "playersTable": "ArkShopPlayers",
 *       "playersPointsColumn": "Points",
 *       "playersEosColumn": "EosId",
 *       "permissionGroupsTable": "PermissionGroups",
 *       "permissionGroupsNameColumn": "GroupName",
 *       "permissionGroupsPermsColumn": "Permissions",
 *       "playerPermsTable": "Players",
 *       "playerPermsEosColumn": "EOS_Id",
 *       "playerPermsGroupColumn": "PermissionsGroups"
 *     },
 *     "intervalMinutes": 30,
 *     "pointsByPermission": {
 *       "Default": 10,
 *       "VIP": 25,
 *       "Admin": 100
 *     },
 *     "defaultPoints": 5
 *   }
 * }
 *
 * Other actions:
 *   { "action": "stop" }
 *   { "action": "status" }
 *   { "action": "runOnce" }   // immediately award points
 */

const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`[WS] WebSocket server listening on port ${WS_PORT}`);
});

wss.on('connection', (ws, req) => {
  const connId = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

  if (!isAuthorized(req)) {
    console.warn(`[WS] Unauthorized connection attempt: ${connId}`);
    try {
      ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    } catch (_) {}
    ws.close(1008, 'Unauthorized');
    return;
  }

  console.log(`[WS] Client connected: ${connId}`);

  ws.send(JSON.stringify({ type: 'hello', message: 'Ready. Send {action:"start", config:{...}}' }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }

    const action = (msg.action || '').toLowerCase();

    try {
      if (action === 'start') {
        const cfg = normalizeConfig(msg.config || {});
        await testConnection(cfg);
        await ensureSchema(cfg);

        // stop any existing job for this connection
        stopJob(connId);

        const job = startAwardLoop(connId, cfg, ws);
        activeJobs.set(connId, job);

        ws.send(JSON.stringify({
          type: 'started',
          intervalMinutes: cfg.intervalMinutes,
          message: `Awarding points every ${cfg.intervalMinutes} minute(s).`
        }));

        // Award immediately once, then on interval
        await awardPoints(cfg, ws);
      } else if (action === 'stop') {
        stopJob(connId);
        ws.send(JSON.stringify({ type: 'stopped' }));
      } else if (action === 'status') {
        const job = activeJobs.get(connId);
        ws.send(JSON.stringify({
          type: 'status',
          running: !!job,
          intervalMinutes: job ? job.cfg.intervalMinutes : null
        }));
      } else if (action === 'runonce') {
        if (!msg.config) {
          const job = activeJobs.get(connId);
          if (!job) return ws.send(JSON.stringify({ type: 'error', message: 'No config and no active job' }));
          await awardPoints(job.cfg, ws);
        } else {
          const cfg = normalizeConfig(msg.config);
          await ensureSchema(cfg);
          await awardPoints(cfg, ws);
        }
        ws.send(JSON.stringify({ type: 'runonce-complete' }));
      } else {
        ws.send(JSON.stringify({ type: 'error', message: `Unknown action: ${action}` }));
      }
    } catch (err) {
      console.error('[ERR]', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${connId}`);
    stopJob(connId);
  });

  ws.on('error', (err) => console.error(`[WS] Socket error (${connId}):`, err.message));
});

// ---------- Config handling ----------
function normalizeConfig(raw) {
  const m = raw.mysql || {};
  const t = raw.tables || {};

  const cfg = {
    mysql: {
      host: m.host || '127.0.0.1',
      port: m.port || 3306,
      user: m.user,
      password: m.password,
      database: m.database,
      connectionLimit: 4
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
    intervalMinutes: Number(raw.intervalMinutes) > 0 ? Number(raw.intervalMinutes) : 30,
    pointsByPermission: raw.pointsByPermission || { Default: 10, VIP: 25, Admin: 100 },
    defaultPoints: typeof raw.defaultPoints === 'number' ? raw.defaultPoints : 5
  };

  if (!cfg.mysql.user || !cfg.mysql.database) {
    throw new Error('mysql.user and mysql.database are required');
  }

  // Basic SQL identifier safety check (avoid injection through config)
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
    // ArkShopPlayers (same name as playersTable/ArkShopPlayers)
    `CREATE TABLE IF NOT EXISTS \`${playersTable}\` (
      \`Id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`${playersEosColumn}\` VARCHAR(64) NOT NULL UNIQUE,
      \`Kits\` TEXT NULL,
      \`${playersPointsColumn}\` INT NOT NULL DEFAULT 0,
      \`TotalSpent\` INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // PermissionGroups
    `CREATE TABLE IF NOT EXISTS \`${permissionGroupsTable}\` (
      \`Id\` INT AUTO_INCREMENT PRIMARY KEY,
      \`${permissionGroupsNameColumn}\` VARCHAR(64) NOT NULL UNIQUE,
      \`${permissionGroupsPermsColumn}\` TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,

    // Players
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
    database: cfg.mysql.database,
    multipleStatements: false
  });

  try {
    for (const stmt of ddl) {
      await conn.query(stmt);
    }
    // Seed a Default group if the table is empty
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
  const ms = cfg.intervalMinutes * 60 * 1000;
  const timer = setInterval(async () => {
    try {
      await awardPoints(cfg, ws);
    } catch (e) {
      console.error('[Award] failed:', e.message);
      try { ws.send(JSON.stringify({ type: 'error', message: `Award failed: ${e.message}` })); } catch (_) {}
    }
  }, ms);

  return { timer, cfg };
}

function stopJob(connId) {
  const job = activeJobs.get(connId);
  if (job) {
    clearInterval(job.timer);
    activeJobs.delete(connId);
  }
}

// ---------- Core award logic ----------
async function awardPoints(cfg, ws) {
  const {
    playersTable, playersPointsColumn, playersEosColumn,
    permissionGroupsTable, permissionGroupsNameColumn, permissionGroupsPermsColumn,
    playerPermsTable, playerPermsEosColumn, playerPermsGroupColumn
  } = cfg.tables;

  const pool = mysql.createPool(cfg.mysql);

  try {
    // 1) Map: permission group name -> points (from config)
    //    Config's pointsByPermission keys should match GroupName values in PermissionGroups
    const pointsByGroup = cfg.pointsByPermission;

    // 2) Get all players and their permission group (from Players table)
    const [players] = await pool.query(
      `SELECT \`${playerPermsEosColumn}\` AS eosId, \`${playerPermsGroupColumn}\` AS groupName
       FROM \`${playerPermsTable}\``
    );

    if (players.length === 0) {
      safeSend(ws, { type: 'award', awarded: 0, message: 'No players found in Players table.' });
      return;
    }

    // 3) Build awards: eosId -> points
    const awards = players.map(p => {
      const group = (p.groupName || '').trim();
      const pts = Object.prototype.hasOwnProperty.call(pointsByGroup, group)
        ? Number(pointsByGroup[group])
        : cfg.defaultPoints;
      return { eosId: p.eosId, points: isFinite(pts) ? pts : cfg.defaultPoints, group };
    });

    // 4) Filter to those that exist in ArkShopPlayers
    const eosIds = awards.map(a => a.eosId).filter(Boolean);
    if (eosIds.length === 0) {
      safeSend(ws, { type: 'award', awarded: 0, message: 'No valid EOS ids.' });
      return;
    }

    const placeholders = eosIds.map(() => '?').join(',');
    const [existing] = await pool.query(
      `SELECT \`${playersEosColumn}\` AS eosId
       FROM \`${playersTable}\`
       WHERE \`${playersEosColumn}\` IN (${placeholders})`,
      eosIds
    );
    const existingSet = new Set(existing.map(r => r.eosId));

    const finalAwards = awards.filter(a => existingSet.has(a.eosId));

    // 5) Apply updates in a transaction
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
        }
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    safeSend(ws, {
      type: 'award',
      timestamp: new Date().toISOString(),
      awardedPlayers: perPlayer.length,
      totalPointsAwarded: totalAwarded,
      details: perPlayer
    });

    console.log(`[Award] Awarded ${totalAwarded} points to ${perPlayer.length} players.`);
  } finally {
    await pool.end();
  }
}

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (_) { /* ignore */ }
}

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  for (const [, job] of activeJobs) clearInterval(job.timer);
  wss.close(() => process.exit(0));
});