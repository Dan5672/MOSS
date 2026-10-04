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
sh deploy/init.sh          # creates deploy/.env and the master key
docker compose -f deploy/docker-compose.yml up -d
pnpm install
pnpm -r run test
pnpm -r run build && pnpm --filter @moss/db migrate   # needs DATABASE_URL from deploy/.env
```

## License
AGPL-3.0 open core; commercial license available for business features. Contributions require a CLA.
