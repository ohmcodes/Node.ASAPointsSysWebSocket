# ARK: Ascended Points WebSocket Server

A configurable Node.js WebSocket server that awards in-game points to ARK: Ascended players via their mod. Servers connect, report which players are online, and receive periodic point awards based on each player's permission group.

Designed to handle **multiple ARK servers on one process**, with **zero DB activity when no players are online**.

---

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Running the Server](#running-the-server)
- [WebSocket API](#websocket-api)
  - [Authentication](#authentication)
  - [Message Envelope](#message-envelope)
  - [Actions](#actions)
    - [start](#1-start)
    - [playerOnline](#2-playeronline)
    - [playerOffline](#3-playeroffline)
    - [playerStatus](#4-playerstatus)
    - [status](#5-status)
    - [runOnce](#6-runonce)
    - [stop](#7-stop)
- [How the Award Loop Works](#how-the-award-loop-works)
- [Database Schema](#database-schema)
- [Multi-Server Behavior](#multi-server-behavior)
- [Example Mod Flow](#example-mod-flow)
- [INI Configuration Example](#ini-configuration-example)
- [Security Notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Development & Testing](#development--testing)
- [License](#license)

---

## Features

- 🎯 **Per-permission-group points and intervals** — configure different reward rates for Default, VIP, Admin, etc.
- 🧠 **Online player cache** — only awards points to players actually online on a given server.
- 💤 **Idle servers cost nothing** — no DB queries when no one is online.
- 🔌 **Multi-server ready** — one Node process handles dozens of ARK servers.
- 🛡️ **Token auth** — shared secret in the handshake header.
- 🧱 **Auto schema creation** — missing tables are created on first `start`.
- 🏊 **Shared DB pool cache** — one pool per unique MySQL config (not per server connection).
- ⏱️ **Heartbeat & staleness pruning** — misbehaving mods can't leave "ghost" players in cache.
- 📊 **Rich status responses** — inspect the live cache on any connection at any time.

---

## Architecture Overview

```
┌────────────────┐        WS + token        ┌──────────────────────┐        SQL        ┌────────────┐
│ ARK Server #1  │ ───────────────────────► │                      │ ────────────────► │            │
│  Mod (client)  │ ◄─────────────────────── │   Node.js WS Server  │ ◄──────────────── │   MySQL    │
└────────────────┘   playerOnline/Offline   │  (this project)      │   SELECT/UPDATE   │            │
                                            │                      │                   │            │
┌────────────────┐                           │  • per-conn job      │                   │  Tables:   │
│ ARK Server #2  │ ───────────────────────► │  • player cache      │                   │  • Players │
└────────────────┘                           │  • 1-min ticker      │                   │  • PermGrp │
                                            │  • shared DB pool    │                   │  • ArkShop │
        … up to N servers                    └──────────────────────┘                   └────────────┘
```

- **One WebSocket connection per ARK server.**
- Each connection has its own **job** (interval ticker + player cache + config).
- All connections share MySQL pools keyed by unique DB credentials.
- The mod drives the cache via `playerOnline` / `playerOffline`.
- The server autonomously awards points when a player's group timer elapses.

---

## Requirements

- **Node.js** v18+ (v20.6+ if you want `--env-file` without `dotenv`)
- **MySQL** 5.7+ / MariaDB 10.3+
- **npm** or **yarn**
- Network reachability between each ARK server's mod and this WS server

---

## Installation

```bash
# 1. Clone or drop the files into a directory
mkdir ark-points-ws && cd ark-points-ws

# 2. Initialize npm
npm init -y

# 3. Install dependencies
npm install ws mysql2 dotenv

# 4. Create your server.js (paste the provided file)
# 5. Create .env (see below)
# 6. Create .gitignore
```

`.gitignore`:
```
node_modules/
.env
```

---

## Environment Variables

Create a file named `.env` in the project root:

```env
# ---------- WebSocket server ----------
WS_PORT=8080
# Shared secret required in handshake header.
# Leave unset to disable auth (dev only!).
WS_TOKEN=super-secret-123

# ---------- Default MySQL (optional) ----------
# Used only if a requester omits the mysql block in their start message.
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=arkshop
DB_PASSWORD=yourStrongDbPassword
DB_DATABASE=arkshop

# ---------- Cache behavior ----------
# Drop a player from cache if the mod hasn't re-confirmed them
# in this many minutes (protects against mod crashes).
PLAYER_STALE_MINUTES=5
```

| Variable | Default | Purpose |
|---|---|---|
| `WS_PORT` | `8080` | WebSocket listen port |
| `WS_TOKEN` | *(unset)* | Shared secret for auth. Unset = auth disabled |
| `DB_HOST` | `127.0.0.1` | Fallback MySQL host |
| `DB_PORT` | `3306` | Fallback MySQL port |
| `DB_USER` | *(required if no per-msg config)* | Fallback MySQL user |
| `DB_PASSWORD` | *(none)* | Fallback MySQL password |
| `DB_DATABASE` | *(required if no per-msg config)* | Fallback database |
| `PLAYER_STALE_MINUTES` | `5` | Auto-prune players not re-confirmed within this window |

---

## Running the Server

### Node 20.6+ (no `dotenv` needed)

```bash
node --env-file=.env server.js
```

### Any Node version (uses `dotenv`)

```bash
node server.js
```

Expected startup output:

```
[WS] Listening on port 8080
```

On client connect:

```
[WS] Connected: Island-01@10.0.0.5:51234 (total: 1)
[DB] Created pool for 127.0.0.1:3306/arkshop/arkshop
```

---

## WebSocket API

### Authentication

The server requires a token header (when `WS_TOKEN` is set). Two accepted forms:

| Header | Value |
|---|---|
| `x-auth-token` | `super-secret-123` |
| `Authorization` | `Bearer super-secret-123` |

If auth fails, the server replies with `{"type":"error","message":"Unauthorized"}` and closes with code **1008**.

> ⚠️ Browsers can't send custom WS headers. ARK mods (C++/UE via `libwebsockets`, `websocketpp`, UE's `FWebSocket`) can.

### Message Envelope

- All messages are **JSON strings** (UTF-8).
- The server replies with JSON objects that always have a `type` field.
- The `action` field in incoming messages selects the handler (case-insensitive).

### Actions

#### 1. `start`

Initialize the job for this connection, test the DB, ensure schema, and begin the ticker.

```json
{
  "action": "start",
  "config": {
    "mysql": {
      "host": "127.0.0.1",
      "port": 3306,
      "user": "arkshop",
      "password": "pw",
      "database": "arkshop"
    },
    "permissionPlans": {
      "Default": { "points": 10,  "intervalMinutes": 30 },
      "VIP":     { "points": 25,  "intervalMinutes": 15 },
      "Admin":   { "points": 100, "intervalMinutes": 5 }
    },
    "defaultPermission": "Default"
  }
}
```

Server reply:

```json
{
  "type": "started",
  "message": "Tracking online players. Tick every 1 minute; awards per group interval.",
  "permissionPlans": {
    "Default": { "points": 10,  "intervalMinutes": 30 },
    "VIP":     { "points": 25,  "intervalMinutes": 15 },
    "Admin":   { "points": 100, "intervalMinutes": 5 }
  }
}
```

Notes:
- The `mysql` block can be omitted to use `.env` fallbacks.
- Sending `start` again on the same connection **replaces** the previous job.
- The player cache starts **empty**; the mod must send `playerOnline` to populate it.

#### 2. `playerOnline`

Report that one or more players are online (and, ideally, refresh this every ~2 minutes as a heartbeat).

**Single player:**
```json
{ "action": "playerOnline", "eosId": "0002abc...", "group": "VIP" }
```

**Batch (recommended):**
```json
{
  "action": "playerOnline",
  "players": [
    { "eosId": "0002abc...", "group": "VIP" },
    { "eosId": "0003def...", "group": "Default" }
  ]
}
```

Server reply:
```json
{ "type": "playerOnlineAck", "added": 1, "refreshed": 1, "totalOnline": 2 }
```

Behavior:
- **New player** → added with `lastAwardedAt = now` (timer starts).
- **Existing player, same group** → `lastSeen` refreshed, `lastAwardedAt` untouched.
- **Existing player, group changed** → `lastAwardedAt` reset (fresh interval for new plan).

#### 3. `playerOffline`

Remove one or more players from the cache immediately.

**Single:**
```json
{ "action": "playerOffline", "eosId": "0002abc..." }
```

**Batch:**
```json
{ "action": "playerOffline", "players": ["0002abc...", "0003def..."] }
```

Server reply:
```json
{ "type": "playerOfflineAck", "removed": 2, "totalOnline": 0 }
```

#### 4. `playerStatus`

Ask the server whether specific players are still in its cache.

```json
{ "action": "playerStatus", "players": ["0002abc...", "0003def..."] }
```

Server reply:
```json
{
  "type": "playerStatusResult",
  "players": [
    { "eosId": "0002abc...", "online": true,  "group": "VIP", "lastSeenSecondsAgo": 12 },
    { "eosId": "0003def...", "online": false, "group": null,  "lastSeenSecondsAgo": null }
  ]
}
```

Use this if the mod suspects its own state and the server's cache have drifted. If a player the mod *knows* is in-game shows `online: false`, the mod should resend `playerOnline`.

#### 5. `status`

Full snapshot of this connection's job.

```json
{ "action": "status" }
```

Server reply:
```json
{
  "type": "status",
  "running": true,
  "onlinePlayers": 2,
  "players": [
    {
      "eosId": "0002abc...",
      "group": "VIP",
      "lastSeenSecondsAgo": 8,
      "lastAwardedSecondsAgo": 220
    },
    {
      "eosId": "0003def...",
      "group": "Default",
      "lastSeenSecondsAgo": 40,
      "lastAwardedSecondsAgo": 40
    }
  ]
}
```

#### 6. `runOnce`

Force-award **all cached online players** immediately, ignoring intervals. Useful for admin commands and testing.

```json
{ "action": "runOnce" }
```

Server reply:
```json
{ "type": "runonce-complete" }
```

The normal `award` message is also sent (see below) if any points were awarded.

#### 7. `stop`

Stop the ticker and clear the cache for this connection.

```json
{ "action": "stop" }
```

Server reply:
```json
{ "type": "stopped" }
```

### Server-Initiated Messages

In addition to action replies, the server sends:

| `type` | When |
|---|---|
| `hello` | Immediately on successful handshake (if no `hello`-guard) |
| `award` | When one or more players received points |
| `error` | On invalid action, invalid JSON, DB error, etc. |

**`award` example:**
```json
{
  "type": "award",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "awardedPlayers": 2,
  "totalPointsAwarded": 35,
  "details": [
    { "eosId": "0002abc...", "group": "VIP",     "points": 25 },
    { "eosId": "0003def...", "group": "Default", "points": 10 }
  ]
}
```

---

## How the Award Loop Works

1. **On `start`** the server creates a job for that connection:
   - config, permission plans, empty player `Map`.
   - a **1-minute interval ticker**.

2. **On each tick** (every 60s):
   - Prune players not re-confirmed in `PLAYER_STALE_MINUTES`.
   - If the cache is **empty → return immediately (no DB work)**.
   - For each cached player, compute `elapsed = now - lastAwardedAt`.
   - If `elapsed >= plan.intervalMinutes * 60000` → mark as due.
   - Batch-query `ArkShopPlayers` to find which due players exist.
     - Missing ones → `INSERT IGNORE` with `Points = 0`.
   - In a single transaction, `UPDATE Points = Points + N` per player.
   - Update `lastAwardedAt = now` for each awarded player.
   - Emit an `award` message with details.

3. **`playerOnline`** and **`playerOffline`** keep the cache in sync with actual game state.

4. **Stale pruning**: if the mod stops sending heartbeats (crash, network drop), players are silently removed.

### Why per-minute tick instead of per-group timers

Because plans can differ per player (VIP every 15 min, Default every 30 min), a **single low-frequency ticker** that checks "who is due" is simpler and cheaper than maintaining thousands of per-player timers.

At 1000 online players, a tick costs one `Map` iteration — negligible.

---

## Database Schema

On first `start`, missing tables are created automatically:

### `ArkShopPlayers`
| Column | Type | Notes |
|---|---|---|
| `Id` | INT AUTO_INCREMENT | PK |
| `EosId` | VARCHAR(64) | UNIQUE, configurable name |
| `Kits` | TEXT | nullable |
| `Points` | INT | default 0, configurable name |
| `TotalSpent` | INT | default 0 |

### `PermissionGroups`
| Column | Type | Notes |
|---|---|---|
| `Id` | INT AUTO_INCREMENT | PK |
| `GroupName` | VARCHAR(64) | UNIQUE |
| `Permissions` | TEXT | nullable |

A row named `Default` is seeded if the table is empty.

### `Players`
| Column | Type | Notes |
|---|---|---|
| `Id` | INT AUTO_INCREMENT | PK |
| `EOS_Id` | VARCHAR(64) | UNIQUE |
| `PermissionsGroups` | VARCHAR(64) | group name |
| `TimePermissionGroups` | DATETIME | nullable |

> The `Players` and `PermissionGroups` tables are present for compatibility with your existing schema; the WS server does **not** currently read from them during awards. Group assignment comes from the `playerOnline` messages (so the mod is the single source of truth for who is which group).

Table and column names are all configurable per-connection via `config.tables`.

---

## Multi-Server Behavior

| Scenario | Result |
|---|---|
| 10 servers, 1 DB, 5 online each | **1 pool**, 5 MySQL connections total. All 10 jobs tick independently. |
| 10 servers, 10 DBs, all online | 10 pools × 5 = 50 MySQL connections. Fine under default `max_connections=151`. |
| Server with 0 online players | Ticker runs but returns instantly. **Zero SQL.** |
| Same DB across servers | Pool shared by `host:port/db/user` key. |
| Two servers host the same EOS id simultaneously (rare) | Each job independently awards; total reflects the sum. Use permission-group rules to control this if needed. |

---

## Example Mod Flow

**On mod startup:**
```json
{ "action": "start", "config": { /* INI-derived */ } }
```

**On player login:**
```json
{ "action": "playerOnline", "eosId": "0002abc...", "group": "VIP" }
```

**Every ~2 minutes while in-game (heartbeat):**
```json
{
  "action": "playerOnline",
  "players": [
    { "eosId": "0002abc...", "group": "VIP" },
    { "eosId": "0003def...", "group": "Default" }
  ]
}
```

**On player logout:**
```json
{ "action": "playerOffline", "eosId": "0002abc..." }
```

**On mod shutdown (optional):**
```json
{ "action": "stop" }
```

**Whenever the mod wants to double-check state:**
```json
{ "action": "playerStatus", "players": ["0002abc..."] }
```

---

## INI Configuration Example

Your ARK mod reads an INI like:

```ini
[PointsSystem]
DefaultPermission=Default

[Default]
Points=10
IntervalMinutes=30

[VIP]
Points=25
IntervalMinutes=15

[Admin]
Points=100
IntervalMinutes=5
```

The mod builds the `permissionPlans` object from these sections and sends them with `start`:

```json
"permissionPlans": {
  "Default": { "points": 10,  "intervalMinutes": 30 },
  "VIP":     { "points": 25,  "intervalMinutes": 15 },
  "Admin":   { "points": 100, "intervalMinutes": 5 }
}
```

- Any group sent by the mod that isn't in `permissionPlans` falls back to `defaultPermission`'s plan.
- If a group's plan is missing entirely, points = 0 for safety.

---

## Security Notes

- **Bind to a trusted network.** This service accepts DB credentials over the wire. Use a VPN, private LAN, or Docker network — do **not** expose to the public internet.
- **Always set `WS_TOKEN`** in production.
- **Use a dedicated MySQL user** with least privilege:
  ```sql
  CREATE USER 'arkshop'@'10.0.0.%' IDENTIFIED BY 'strongpw';
  GRANT SELECT, INSERT, UPDATE ON arkshop.* TO 'arkshop'@'10.0.0.%';
  -- Only needed on first run for auto-schema creation:
  -- GRANT CREATE ON arkshop.* TO 'arkshop'@'10.0.0.%';
  ```
- **Do not log raw configs.** The provided code only logs connection identity.
- **Rotate `WS_TOKEN`** if a mod client is compromised.
- **Consider TLS.** If your ARK hosts traverse untrusted networks, put this behind a TLS-terminating reverse proxy (e.g. nginx, Caddy) or use `ws` over HTTPS via a front proxy.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Unauthorized`, close 1008 | Missing/wrong token header | Check `WS_TOKEN` and how the mod sets headers |
| `mysql.user and mysql.database are required` | No per-msg config and no `.env` fallback | Set `.env` or send `config.mysql` |
| `ECONNREFUSED` on start | MySQL unreachable | Verify host/port, firewall |
| `Invalid identifier for X` | Table/column name has illegal chars | Use only `[A-Za-z0-9_]` |
| Awards not happening | Player cache empty | Mod must send `playerOnline` |
| Awards happening too often | `lastAwardedAt` reset on group change | Expected: group change restarts the interval |
| Players "stuck" online after crash | Missing heartbeat | Lower `PLAYER_STALE_MINUTES` or fix the mod's heartbeat |
| Award skipped with no message | Cache empty — by design | Send `status` to confirm `onlinePlayers` |
| Duplicate awards across two servers | Same EOS id online in both | Config-level rule needed; ask mod to only report the "primary" server |

Enable verbose MySQL errors by wrapping in try/catch — the server already forwards `err.message` in `error` messages.

---

## FAQ

**Q: Can I run this behind Docker?**
Yes. Mount `.env`, expose `WS_PORT`, and ensure the container can reach MySQL.

**Q: Does the server read the `Players` table to determine groups?**
No. Group assignment comes from the `playerOnline` message. This makes the mod the single source of truth and avoids stale DB state.

**Q: What happens if the mod sends `start` twice?**
The previous job is stopped and a fresh one begins with an empty player cache. Re-send `playerOnline` for all online players after restarting.

**Q: Can different servers share one DB?**
Yes. Pools are shared by `host:port/db/user`. Points awarded per server are added to the same rows.

**Q: What if a player changes permission group in-game?**
Send `playerOnline` again with the new `group`. The server resets the interval so the new plan takes effect from that moment.

**Q: How many concurrent servers can it handle?**
10 is trivial. 100+ works with default MySQL limits (adjust `max_connections` and per-pool size for very large fleets).

**Q: Are points awarded in the same second for all players?**
Yes, on the tick where their interval elapses. Ticks happen every 60s, so accuracy is ±1 minute.

**Q: What happens to a player's points if they disconnect mid-interval?**
They keep whatever was last awarded. On reconnect, the timer starts fresh from login.

**Q: Can I add my own action?**
Yes — extend the `ws.on('message', ...)` handler with another `else if (action === '...')` branch. Keep messages JSON and reply with a `type`.

---

## Development & Testing

### Quick local test

Use `wscat`:

```bash
npm install -g wscat
wscat -c ws://127.0.0.1:8080 -H "x-auth-token: super-secret-123"
```

Then paste:

```json
{"action":"start","config":{"permissionPlans":{"Default":{"points":5,"intervalMinutes":1}}}}
```

```json
{"action":"playerOnline","eosId":"test-eos-1","group":"Default"}
```

```json
{"action":"status"}
```

Wait ~60s, or send `runOnce` for an immediate award.

### Node script test

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8080', {
  headers: { 'x-auth-token': 'super-secret-123' }
});

ws.on('open', () => {
  ws.send(JSON.stringify({
    action: 'start',
    config: { permissionPlans: { Default: { points: 5, intervalMinutes: 1 } } }
  }));
  setTimeout(() => {
    ws.send(JSON.stringify({ action: 'playerOnline', eosId: 'test-eos-1', group: 'Default' }));
  }, 500);
});

ws.on('message', m => console.log('<<', m.toString()));
```

### Recommended automated tests

- Connect without token → expect close 1008.
- `start` with bad DB → expect error message, connection still open.
- `start`, `playerOnline x3`, wait 65s → expect one `award` with 3 entries.
- `playerOffline` one → wait 65s → expect `award` with 2 entries.
- `stop` → wait 65s → expect no `award`.

---

## License

MIT — do whatever you want, no warranty.

---

## Changelog

- **v1.1** — Added online player cache, per-group intervals, `playerOnline` / `playerOffline` / `playerStatus` actions, stale pruning, shared pool cache, per-connection `x-server-name` in logs.
- **v1.0** — Initial release: configurable interval, token auth, auto schema, multi-connection support.