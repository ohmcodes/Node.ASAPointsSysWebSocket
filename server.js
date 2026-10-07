'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const mysql = require('mysql2/promise');

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`[FATAL] config.json not found at ${CONFIG_PATH}`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const {
  websocket: wsCfg,
  mysql: dbCfg,
  playersTable: playersTbl,
  arkShopPlayersTable: arkTbl,
  permissionPoints
} = config;

// ---------------------------------------------------------------------------
// Validate identifiers (prevents SQL injection from config typos)
// ---------------------------------------------------------------------------
const IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;
function assertIdentifier(label, value) {
  if (!IDENTIFIER_RE.test(value)) {
    console.error(`[FATAL] Invalid SQL identifier for ${label}: "${value}"`);
    process.exit(1);
  }
}
assertIdentifier('playersTable.name', playersTbl.name);
assertIdentifier('playersTable.idColumn', playersTbl.idColumn);
assertIdentifier('playersTable.permissionsColumn', playersTbl.permissionsColumn);
assertIdentifier('arkShopPlayersTable.name', arkTbl.name);
assertIdentifier('arkShopPlayersTable.idColumn', arkTbl.idColumn);
assertIdentifier('arkShopPlayersTable.pointsColumn', arkTbl.pointsColumn);

// ---------------------------------------------------------------------------
// MySQL pool
// ---------------------------------------------------------------------------
const pool = mysql.createPool({
  host: dbCfg.host,
  port: dbCfg.port,
  user: dbCfg.user,
  password: dbCfg.password,
  database: dbCfg.database,
  waitForConnections: true,
  connectionLimit: dbCfg.connectionLimit || 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

// ---------------------------------------------------------------------------
// Core: award points for a given EOS_ID
// ---------------------------------------------------------------------------
async function awardPoints(eosId) {
  const conn = await pool.getConnection();
  try {
    // 1) Get PermissionGroups from Players table
    const selectSql = `
      SELECT \`${playersTbl.permissionsColumn}\` AS PermissionGroups
      FROM \`${playersTbl.name}\`
      WHERE \`${playersTbl.idColumn}\` = ?
      LIMIT 1
    `;
    const [playerRows] = await conn.execute(selectSql, [eosId]);

    if (!playerRows.length) {
      return { ok: false, reason: 'player_not_found', eosId };
    }

    const permString = playerRows[0].PermissionGroups || '';
    const groups = String(permString)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!groups.length) {
      return { ok: false, reason: 'no_permissions', eosId };
    }

    // 2) Highest = LAST item in the comma-separated list
    const highestGroup = groups[groups.length - 1];

    // 3) Lookup points from config
    const points = permissionPoints[highestGroup];

    if (typeof points !== 'number' || points <= 0) {
      return {
        ok: false,
        reason: 'no_points_configured_for_group',
        eosId,
        highestGroup
      };
    }

    // 4) Atomically add points to ArkShopPlayers
    await conn.beginTransaction();

    const updateSql = `
      UPDATE \`${arkTbl.name}\`
      SET \`${arkTbl.pointsColumn}\` = \`${arkTbl.pointsColumn}\` + ?
      WHERE \`${arkTbl.idColumn}\` = ?
    `;
    const [result] = await conn.execute(updateSql, [points, eosId]);

    if (result.affectedRows === 0) {
      await conn.rollback();
      return { ok: false, reason: 'arkshop_player_not_found', eosId };
    }

    // Fetch new total
    const [pointsRows] = await conn.execute(
      `SELECT \`${arkTbl.pointsColumn}\` AS Points
       FROM \`${arkTbl.name}\`
       WHERE \`${arkTbl.idColumn}\` = ?
       LIMIT 1`,
      [eosId]
    );

    await conn.commit();

    const newPoints = Number(pointsRows[0]?.Points) || 0;

    return {
      ok: true,
      eosId,
      highestGroup,
      awarded: points,
      newPoints
    };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

// Token auth on upgrade
httpServer.on('upgrade', (req, socket, head) => {
  const headerName = (wsCfg.tokenHeader || 'x-auth-token').toLowerCase();
  const provided = req.headers[headerName];

  if (!provided || provided !== wsCfg.authToken) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    console.warn(`[AUTH] Rejected: ${req.socket.remoteAddress}`);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Connected: ${ip}`);

  // Serialize handling per client so rapid messages don't race
  let queue = Promise.resolve();

  ws.on('message', (raw) => {
    queue = queue.then(async () => {
      const eosId = raw.toString('utf8').trim();

      if (!eosId) {
        ws.send(JSON.stringify({ ok: false, reason: 'empty_message' }));
        return;
      }

      try {
        const result = await awardPoints(eosId);
        ws.send(JSON.stringify(result));
        console.log(`[AWARD] ${eosId} ->`, result);
      } catch (err) {
        console.error('[ERROR] awardPoints:', err);
        ws.send(JSON.stringify({ ok: false, reason: 'server_error' }));
      }
    }).catch(err => console.error('[ERROR] queue:', err));
  });

  ws.on('close', () => console.log(`[WS] Disconnected: ${ip}`));
  ws.on('error', (err) => console.error(`[WS] Error (${ip}):`, err.message));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(wsCfg.port, wsCfg.host, async () => {
  console.log(`[START] ws://${wsCfg.host}:${wsCfg.port}`);
  console.log(`[START] Auth header: ${wsCfg.tokenHeader}`);
  try {
    const c = await pool.getConnection();
    await c.ping();
    c.release();
    console.log('[START] MySQL OK');
  } catch (err) {
    console.error('[FATAL] MySQL:', err.message);
    process.exit(1);
  }
});

// Graceful shutdown
async function shutdown(sig) {
  console.log(`\n[SHUTDOWN] ${sig}`);
  wss.close();
  httpServer.close();
  try { await pool.end(); } catch {}
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));