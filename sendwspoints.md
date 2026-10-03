Start awarding every 30 minutes (default)
{
  "action": "start",
  "config": {
    "mysql": {
      "host": "127.0.0.1",
      "port": 3306,
      "user": "arkshop",
      "password": "yourpassword",
      "database": "arkshop"
    },
    "intervalMinutes": 30,
    "pointsByPermission": {
      "Default": 10,
      "VIP": 25,
      "Admin": 100
    },
    "defaultPoints": 5
  }
}


Stop awarding
{ "action": "stop" }

Check status
{ "action": "status" }

Award once immediately
{ "action": "runOnce" }

How Permissions Flow
Players table has EOS_Id + PermissionsGroups (group name, e.g. "VIP").

Config pointsByPermission maps group name → points ("VIP": 25).

Only players that exist both in Players (with a group) and in ArkShopPlayers get points.

Fallback to defaultPoints if a group isn't listed in the config.

Sample Response from Server
{
  "type": "award",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "awardedPlayers": 3,
  "totalPointsAwarded": 60,
  "details": [
    { "eosId": "0002abc...", "group": "VIP",   "points": 25 },
    { "eosId": "0003def...", "group": "Admin", "points": 100 },
    { "eosId": "0004ghi...", "group": "Default","points": 10 }
  ]
}


Endpoint
ws://YOUR_SERVER_IP:8080

The mod can:

On startup, send {"action":"start", "config":{...}} with the DB creds and interval.

Query {"action":"status"} any time to confirm it's running.

Use {"action":"runOnce"} for on-demand awards (e.g. admin command).

Send {"action":"stop"} before shutdown.

Security recommendations:

Put this behind a private network or bind to 127.0.0.1 / VPN — anyone who can reach it can push DB credentials.

Add a shared-secret token in the hello handshake (e.g. check req.headers['x-auth-token']) if exposed.

Use a dedicated MySQL user with UPDATE/SELECT only on these three tables.