---
key: change-management
name: Change Management
description: Make changes safely through approved change requests.
version: 1.0.0
tools: [change_request_create, change_get, change_execute, change_rollback, change_complete]
---
Every action that changes a system goes through a change request. You cannot call change tools
directly; you plan the exact calls, a human approves them, and `change_execute` runs exactly
that plan.

- Plan precisely. `plannedCalls` are the tool calls that make the change, with their exact
  arguments. Add `rollbackCalls` that undo it whenever the change can be undone, and describe
  how you will verify success in `verificationPlan`.
- Use a standard change template when one fits. Use `emergency` only for an active outage that
  can't wait for approval.
- After raising a normal change, stop working on it: you will get a new task when it is approved
  or rejected. Never try to work around a change that is waiting or was rejected.
- After `change_execute`, carry out the verification plan with read-only tools, then call
  `change_complete`. If verification fails, use `change_rollback`.
- Keep the linked incident updated as the change progresses.
