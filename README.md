# MOSS — Managed Operations & Systems Service

 **Your AI IT department.**

A self-hosted AI IT department for home and small networks. You hire AI agents (Systems Admin,
Network Admin, Security Admin, Developer, …) that discover and inventory your network, work
incidents, and propose changes through real change management, all inside budgets and
permissions you control.

> Status: early development (v0.1, milestone 1: foundation + safety core).

## Safety model
- Agents never run raw shell. They call **typed tools** through the **Policy Gate**
  (`packages/policy`), which enforces:
  - kill switch, agent status and budget
  - tool grants
  - allowed / off-limits / unknown networks (unknown is denied by default)
  - approved change requests for any state-changing call (the call must exactly match the approved plan)
  - secret grants and secret scopes
- Secrets use envelope encryption (`packages/core`). Agents only ever see `secret:<name>` handles.
- Every action is written to a hash-chained audit log.

## Backups and upgrades
Your data lives in the `pgdata` volume, `deploy/secrets/` and `deploy/.env`. Containers hold no
state, so upgrades happen in place and nothing needs reconfiguring.

```sh
sh deploy/backup.sh                      # database + secrets + .env -> deploy/backups/moss-backup-<time>.tar.gz
sh deploy/upgrade.sh                     # back up, update to the newest release, rebuild, migrate, health-check
sh deploy/upgrade.sh v0.2.0              # or a specific release, branch or commit (forward only)
sh deploy/upgrade.sh --rollback          # return to the version before the last upgrade
sh deploy/restore.sh <backup> [--checkout]   # restore a backup (--checkout: and the code it was taken with)
```

- The new version is built while the old one keeps running, so a failed build changes nothing.
  Database migrations run in a single transaction, so a failed migration leaves the database as it was.
- `--rollback` reuses the previous images (no rebuild). It restores the pre-upgrade backup only if the
  upgrade changed the database. In that case anything recorded since the upgrade is lost.
- Backups contain the master key. They are written owner-only, and the newest 10 are kept
  (`MOSS_BACKUP_KEEP`). Copy them off the machine: without `master.key`, stored secrets can't be decrypted.
- To move to a new machine, clone MOSS, then run `sh deploy/restore.sh <backup>` before `init.sh`.
- If you run extra compose files (such as the lab), set `MOSS_COMPOSE_FILES` in `deploy/.env`, e.g.
  `MOSS_COMPOSE_FILES=docker-compose.yml lab/compose.lab.yml`.

## Development
```sh
corepack enable            # provides pnpm (or prefix commands with `corepack pnpm`)
sh deploy/init.sh          # creates deploy/.env, the master key and service tokens
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build   # postgres, migrate, gate, toolbox
pnpm install && pnpm -r run build
```

Tests: unit tests always run. Database integration tests run when `MOSS_TEST_DATABASE_URL` is set;
each suite creates its own `<db>_<suite>` database, so packages can test in parallel.
```sh
MOSS_TEST_DATABASE_URL=postgres://moss:<password>@localhost:5432/moss_test pnpm -r run test
```

### Lab network
`deploy/lab/compose.lab.yml` adds an allowed subnet (172.30.10.0/24) and an off-limits subnet
(172.30.66.0/24), each with target containers.
```sh
docker compose -f deploy/docker-compose.yml -f deploy/lab/compose.lab.yml --env-file deploy/.env up -d --build
DATABASE_URL=postgres://moss:<password>@localhost:5432/moss node apps/worker/dist/scripts/seed-lab.js   # prints an agent id
curl -X POST http://127.0.0.1:7080/v1/tool-calls \
  -H "authorization: Bearer $(cat deploy/secrets/gate.token)" -H 'content-type: application/json' \
  -d '{"agentId":"<id>","tool":"nmap_scan","args":{"targets":["172.30.10.0/24"],"profile":"top100"}}'
```
Scans of 172.30.10.0/24 run; anything touching 172.30.66.0/24 is denied by the gate.

### Monitoring
Monitoring (web UI → Monitoring) runs ping, TCP, HTTP(S), TLS-expiry and DNS checks from the toolbox,
through the gate, so monitors follow the same network rules as agents. It also accepts alerts from
Uptime Kuma, Beszel, Prometheus Alertmanager or any JSON sender (Monitoring → Webhook sources). When
a monitor goes down, MOSS raises an incident and assigns it to the monitor's responder agent, which
starts working it. Recovery is noted on the incident. Outages during an in-progress change on the
monitored asset do not raise incidents. External senders must be able to reach the web UI, so set
`MOSS_WEB_BIND` in `deploy/.env` if they run on another machine.

## License
AGPL-3.0 open core; commercial license available for business features. Contributions require a CLA.
