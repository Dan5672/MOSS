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

## License
AGPL-3.0 open core; commercial license available for business features. Contributions require a CLA.
