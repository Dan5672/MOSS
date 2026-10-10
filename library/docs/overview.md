# MOSS overview

## What MOSS is
MOSS (Managed Operations & Systems Service) is a self-hosted IT department for a home or small network,
staffed by AI agents. People hire agents (Network Admin, Systems Admin, Security Admin, IT Manager, or
custom ones), give them skills, budgets and recurring tasks, and the agents discover the network, keep
an inventory, watch services, work incidents and propose changes. Every action goes through a policy
gate and is written to a hash-chained audit log.

## The parts (services)
- web: the web UI and its server actions. People sign in here.
- worker: runs agents (one run per agent at a time), turns recurring tasks into runs, handles events
  (incidents assigned, changes approved, comments, monitors going down), runs monitor checks and the
  Home Assistant integration's background work.
- gate: the policy gate and secrets broker. The only service that holds the master key and the only
  path to the toolbox. Every network tool call an agent makes is checked here.
- toolbox: typed network tools (nmap, arp-scan, ping, DNS, probes, SNMP, SSH checks, device APIs).
  There is no shell and no "run a command" tool.
- postgres: the database (PostgreSQL 17 with pgvector) and the job queue.

## Pages
The sidebar: Dashboard, Basement, Chat, Agents, Assets, Wiki, Monitoring, Incidents, Changes, Activity, Settings.
- Dashboard: Getting started checklist (dismissible), a briefing, counts, the team and the incident queue.
- Basement: a live picture of the agents at their desks or on a break. Click an agent to see what it's doing.
- Chat: direct messages and channels (#general is everyone) with agents and people.
- Agents, with tabs Team, Models, Recurring tasks, Tool access, Custom tools. Each agent has a page with its
  runs, skills, mascot, model, budgets and recurring tasks. "Hire an agent" is the button at the top right.
- Assets (each with its Agent access and a setup wizard), Wiki, Incidents, Changes (list or board).
- Monitoring, with tabs Monitors, Dashboards (graphs, gauges and status; TV mode for a wall screen) and
  Webhook sources.
- Activity, with tabs Agent activity (every run, step by step) and Audit log.
- Settings, with tabs General, Security, Secrets, Backups, Integrations, Networks, Users.

## Runs
Every piece of agent work is a run: a task, from a person (a task or a chat message), a recurring task,
an event (an incident assigned, a change approved, a comment) or a monitor. A run has steps (what the
agent said, the tools it called, their results, any policy denials) and ends succeeded, failed or
aborted. Agent activity lists them; each run page shows every step, its cost and tokens. An agent runs
one thing at a time; other work waits in the queue.
