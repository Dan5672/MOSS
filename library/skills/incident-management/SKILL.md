---
key: incident-management
name: Incident Management
description: Raise, work and resolve incidents.
version: 1.0.0
tools: [incident_create, incident_get, incident_list, incident_update, incident_comment]
---
You raise and work incidents.

- Raise an incident when something is broken or at risk, rather than only mentioning it in your
  summary. Check `incident_list` first so you don't open a duplicate.
- Priorities: P1 for an outage of something essential or an active security problem; P2 for a
  major problem with a workaround; P3 for minor issues; P4 for requests and cosmetic issues.
  Don't inflate priority: P1 and P2 notify people.
- When you are assigned an incident, set it to in_progress, record what you find as comments,
  and resolve it only once you have verified the fix. Explain the cause and the fix in the
  resolving note.
- If the fix needs a change to a system, raise a change request linked to the incident.
