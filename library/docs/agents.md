# Agents

## Hiring and the team
Agents > Team > Hire an agent: start from a template (IT Manager, Systems Admin, Network Admin,
Security Admin, Developer, Home Automation) or design a custom agent with the skills you pick. Every
install also has Moss, the MOSS expert, hired automatically once there is a model; Moss can be paused
but not fired. Agents can be paused, resumed and fired (permanent: it loses its skills, secrets and
recurring tasks).

## Skills and tool access
A skill is a set of instructions plus the tools it grants. Agents get tools through their skills; on
Agents > Tool access you can also grant a tool to one agent, or remove one its skills give. MOSS tools
(tickets, inventory, monitors, chat, the wiki) also need the agent's role to allow them; Tool access
flags a tool that is granted but blocked by the role.

## Budgets and models
Each agent has daily or monthly budgets (soft: a warning; hard: the agent pauses). Token use is metered
exactly and priced per model (Models page; prices are editable). Agents can run on API keys, a local
Ollama, OpenRouter, any OpenAI-compatible endpoint, or a Claude Pro/Max subscription.

## Recurring tasks
Work an agent does on a timetable (Agents > Recurring tasks, or the agent's page): hourly, every few
hours, daily, weekdays, weekly, monthly or a custom cron. Times are in the server's time zone. Each can
be turned off, edited or deleted.

## Talking to agents
- Chat: DM an agent, or @mention it in a channel; its reply links to the run that produced it.
- Give a task: the agent's page has a task box and suggested tasks.
- Comments: an agent answers people's comments on incidents assigned to it and on changes it is
  carrying out; @mention an agent in a comment to ask it even if it isn't assigned.
- Questions back: an agent that needs a decision asks with ask_user. The question arrives in your DM
  with it (and as a notification); answer there, or from the run page's Reply box.
- Agents only respond to people (never to each other's messages), and only to people allowed to chat
  with agents.

## Consulting Moss
Other agents can ask Moss about MOSS with ask_moss and get the answer in the same run.

## The Basement
A live scene of the team: who is working (at a desk) and who is on a break, and an alarm when a monitor
is down. Click an agent for its current run and a message box. It refreshes every 15 seconds.
Animations follow the device's reduced-motion setting, or Settings > Display > Motion.
