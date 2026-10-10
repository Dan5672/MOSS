// The MOSS Basement, as a Home Assistant dashboard card. Agents sit at desks while they work and take a break
// when they don't; when a monitor is down, the responder's desk is on fire. Tap an agent to see what it's doing.
// Data comes from the MOSS integration's entities, so it works anywhere Home Assistant does (phones, tablets).
//
//   type: custom:moss-basement-card      # the full scene
//   compact: true                        # optional: a one-line status strip instead
//   title: The Basement                  # optional

const W = 640;
const H = 360;
const DESKS = [
  { x: 300, y: 150 },
  { x: 410, y: 150 },
  { x: 520, y: 150 },
  { x: 300, y: 250 },
  { x: 410, y: 250 },
  { x: 520, y: 250 },
];
const SPOTS = [
  { x: 40, y: 262, what: "on the sofa" },
  { x: 92, y: 262, what: "on the sofa" },
  { x: 168, y: 250, what: "at the coffee machine" },
  { x: 218, y: 286, what: "having a stretch" },
  { x: 140, y: 300, what: "reading" },
  { x: 30, y: 196, what: "by the rack" },
];
const STATUS = { working: "Working", on_break: "On a break", paused: "Paused" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

class MossBasementCard extends HTMLElement {
  setConfig(config) {
    this._config = { compact: false, ...config };
    this._selected = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    // Only redraw when a MOSS entity changed (the hass object updates for every entity in the house).
    const key = this._agents(hass).map((a) => `${a.entity_id}:${a.last_updated}`).join("|") + `|${this._summary(hass)?.last_updated}`;
    if (!prev || key !== this._key) {
      this._key = key;
      this._render();
    }
  }

  getCardSize() {
    return this._config?.compact ? 2 : 7;
  }

  static getStubConfig() {
    return {};
  }

  _agents(hass = this._hass) {
    if (!hass) return [];
    return Object.values(hass.states)
      .filter((s) => s.entity_id.startsWith("sensor.") && s.attributes.moss_agent_id)
      .sort((a, b) => String(a.attributes.agent_name).localeCompare(String(b.attributes.agent_name)));
  }

  _summary(hass = this._hass) {
    if (!hass) return null;
    return Object.values(hass.states).find((s) => s.entity_id.startsWith("sensor.") && Array.isArray(s.attributes.down) && "responder_id" in s.attributes) ?? null;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const agents = this._agents();
    const summary = this._summary();
    const down = summary?.attributes.down ?? [];
    if (!this._hass || (!agents.length && !summary)) {
      this.shadowRoot.innerHTML = `${STYLE}<ha-card><div class="empty">Waiting for MOSS… Is the MOSS integration set up?</div></ha-card>`;
      return;
    }
    this.shadowRoot.innerHTML = STYLE + (this._config.compact ? this._strip(agents, down) : this._scene(agents, down));
    this.shadowRoot.querySelectorAll("[data-agent]").forEach((el) => {
      el.addEventListener("click", () => {
        this._selected = this._selected === el.dataset.agent ? null : el.dataset.agent;
        this._render();
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          el.click();
        }
      });
    });
    this.shadowRoot.querySelector("[data-more]")?.addEventListener("click", (e) => {
      this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: e.currentTarget.dataset.more }, bubbles: true, composed: true }));
    });
  }

  _strip(agents, down) {
    const counts = agents.reduce((n, a) => ((n[a.state] = (n[a.state] ?? 0) + 1), n), {});
    return `<ha-card>
      <div class="strip">
        ${agents
          .map(
            (a) => `<button class="mini ${a.state}" data-agent="${esc(a.entity_id)}" title="${esc(a.attributes.agent_name)}: ${esc(STATUS[a.state] ?? a.state)}">
              <img src="${esc(a.attributes.entity_picture)}" alt="">
              <span class="dot"></span>
            </button>`,
          )
          .join("")}
        <span class="counts">${counts.working ?? 0} working · ${counts.on_break ?? 0} on break${counts.paused ? ` · ${counts.paused} paused` : ""}</span>
        <span class="alarm-chip ${down.length ? "on" : ""}">${down.length ? `${down.length} down` : "All up"}</span>
      </div>
      ${this._detail(agents)}
    </ha-card>`;
  }

  _scene(agents, down) {
    const working = agents.filter((a) => a.state === "working").sort((a, b) => Number(!!b.attributes.responding) - Number(!!a.attributes.responding));
    const resting = agents.filter((a) => a.state !== "working");
    const seats = new Map(working.slice(0, DESKS.length).map((a, i) => [a.entity_id, DESKS[i]]));
    const spots = new Map(resting.slice(0, SPOTS.length).map((a, i) => [a.entity_id, SPOTS[i]]));
    const responder = working.find((a) => a.attributes.responding);

    const desk = (d, i) => {
      const who = working.find((a) => seats.get(a.entity_id) === d);
      return `<g>
        <rect x="${d.x - 40}" y="${d.y + 18}" width="80" height="10" fill="#7a5230" stroke="#14110f" stroke-width="2"/>
        <rect x="${d.x - 34}" y="${d.y + 28}" width="6" height="22" fill="#5e4024"/><rect x="${d.x + 28}" y="${d.y + 28}" width="6" height="22" fill="#5e4024"/>
        <rect x="${d.x + 6}" y="${d.y - 12}" width="30" height="24" fill="#d9cfb4" stroke="#14110f" stroke-width="2"/>
        <rect x="${d.x + 10}" y="${d.y - 8}" width="22" height="15" fill="${who ? "#4dff9a" : "#2b3a33"}" class="${who ? "screen" : ""}"/>
        ${who ? "" : `<text x="${d.x}" y="${d.y + 44}" class="free">DESK ${i + 1}</text>`}
      </g>`;
    };

    // The responder's desk is on fire while a monitor is down (drawn in front of the agent).
    const fire = (d) => `<g class="fire"><polygon points="${d.x + 18},${d.y + 18} ${d.x + 24},${d.y - 14} ${d.x + 30},${d.y + 2} ${d.x + 36},${d.y - 22} ${d.x + 44},${d.y + 18}" fill="#ff6b4a"/>
      <polygon points="${d.x + 22},${d.y + 18} ${d.x + 27},${d.y - 2} ${d.x + 32},${d.y + 8} ${d.x + 37},${d.y - 8} ${d.x + 41},${d.y + 18}" fill="#ffd23f"/></g>`;

    const agentSprite = (a) => {
      const at = seats.get(a.entity_id) ?? spots.get(a.entity_id);
      if (!at) return "";
      const atDesk = seats.has(a.entity_id);
      const x = atDesk ? at.x - 34 : at.x;
      const y = atDesk ? at.y - 30 : at.y - 40;
      const sel = this._selected === a.entity_id;
      const bubble = a.attributes.responding && down.length ? "ON IT!" : a.state === "paused" ? "zZ" : null;
      return `<g class="agent ${a.state}" data-agent="${esc(a.entity_id)}" tabindex="0" role="button" aria-label="${esc(a.attributes.agent_name)}: ${esc(STATUS[a.state] ?? a.state)}">
        <title>${esc(a.attributes.agent_name)}</title>
        <rect x="${x - 4}" y="${y - 4}" width="56" height="70" fill="transparent"/>
        <g class="${atDesk ? "typing" : "bob"}">
        ${sel ? `<rect x="${x - 3}" y="${y - 3}" width="54" height="54" fill="none" stroke="#ffd23f" stroke-width="2" stroke-dasharray="4 3"/>` : ""}
        <image href="${esc(a.attributes.entity_picture)}" x="${x}" y="${y}" width="48" height="48" style="image-rendering:pixelated"/>
        <text x="${x + 24}" y="${y + 60}" class="name">${esc(a.attributes.agent_name)}</text>
        </g>
        ${bubble ? `<g><rect x="${x + 4}" y="${y - 20}" width="${bubble.length * 8 + 10}" height="16" fill="${bubble === "zZ" ? "#e6dcc0" : "#ff6b4a"}" stroke="#14110f" stroke-width="2"/><text x="${x + 9}" y="${y - 8}" class="bubble">${bubble}</text></g>` : ""}
      </g>`;
    };

    const leds = Array.from({ length: 12 }, (_, i) => `<rect x="${24 + (i % 3) * 12}" y="${70 + Math.floor(i / 3) * 24}" width="6" height="4" fill="${i % 4 ? "#4dff9a" : "#ffb547"}" class="led" style="animation-delay:${(i * 0.37) % 2}s"/>`).join("");

    return `<ha-card>
      ${this._config.title ? `<div class="title">${esc(this._config.title)}</div>` : ""}
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="The MOSS Basement: ${working.length} working, ${resting.length} on a break${down.length ? `, ${down.length} monitor(s) down` : ""}">
        <rect width="${W}" height="${H}" fill="#1b2420"/>
        <rect y="220" width="${W}" height="${H - 220}" fill="#2b241e"/>
        ${Array.from({ length: 16 }, (_, i) => `<line x1="${i * 40}" y1="220" x2="${i * 40 - 30}" y2="${H}" stroke="#241e19" stroke-width="2"/>`).join("")}
        <rect x="240" y="30" width="120" height="34" fill="#14110f" stroke="#3a4a42" stroke-width="3"/>
        <text x="300" y="53" class="sign">B1 · IT</text>
        <rect x="14" y="56" width="52" height="150" fill="#14110f" stroke="#3a4a42" stroke-width="3"/>${leds}
        <rect x="20" y="236" width="110" height="34" fill="#a03a2e" stroke="#14110f" stroke-width="3"/>
        <rect x="16" y="226" width="16" height="44" fill="#8a3127" stroke="#14110f" stroke-width="2"/><rect x="118" y="226" width="16" height="44" fill="#8a3127" stroke="#14110f" stroke-width="2"/>
        <rect x="160" y="196" width="40" height="44" fill="#2b2b2b" stroke="#14110f" stroke-width="3"/><rect x="172" y="224" width="16" height="12" fill="#6b4a2e"/>
        <rect x="176" y="186" width="5" height="5" fill="#e6dcc0" class="steam"/>
        <rect x="570" y="40" width="50" height="110" fill="#1d1640" stroke="#0b0816" stroke-width="3"/><rect x="578" y="56" width="34" height="28" fill="#2b1b5e" class="arcade"/>
        ${DESKS.map(desk).join("")}
        ${agents.map(agentSprite).join("")}
        ${responder && down.length && seats.get(responder.entity_id) ? fire(seats.get(responder.entity_id)) : ""}
        ${down.length ? `<g class="overlay"><rect width="${W}" height="${H}" fill="rgba(255,60,40,.10)" class="alarm-tint"/><rect x="10" y="8" width="${Math.min(W - 20, 30 + (down[0].length + (responder ? responder.attributes.agent_name.length + 14 : 0)) * 8)}" height="20" fill="#ff6b4a"/><text x="18" y="22" class="banner">${esc(String(down[0]).toUpperCase())} DOWN${responder ? ` · ${esc(responder.attributes.agent_name.toUpperCase())} RESPONDING` : ""}</text></g>` : ""}
      </svg>
      ${this._detail(agents)}
    </ha-card>`;
  }

  _detail(agents) {
    const a = agents.find((x) => x.entity_id === this._selected);
    if (!a) return `<div class="hint">Tap an agent to see what they're doing.</div>`;
    const at = a.attributes;
    const doing = a.state === "working" ? at.task || "Working" : a.state === "paused" ? "Paused" : "On a break";
    return `<div class="detail">
      <img src="${esc(at.entity_picture)}" alt="">
      <div>
        <div class="who">${esc(at.agent_name)} <span>${esc(at.agent_title)}</span></div>
        <div class="doing">${esc(doing)}</div>
        ${at.last_run_summary ? `<div class="last">Last run (${esc(at.last_run_status)}): ${esc(at.last_run_summary)}</div>` : ""}
        <div class="last">${at.runs_today ?? 0} run(s) today · $${Number(at.cost_today ?? 0).toFixed(2)}</div>
      </div>
      <button data-more="${esc(a.entity_id)}">Details</button>
    </div>`;
  }
}

const STYLE = `<style>
  ha-card { overflow: hidden; }
  svg { display: block; width: 100%; height: auto; }
  .title { padding: 12px 16px 0; font-size: 1.1em; font-weight: 500; }
  .empty, .hint { padding: 12px 16px; color: var(--secondary-text-color); font-size: .9em; }
  text { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .sign { fill: #4dff9a; font-size: 14px; text-anchor: middle; font-weight: 700; }
  .name { fill: #e6dcc0; font-size: 10px; text-anchor: middle; }
  .free { fill: #6b6f8a; font-size: 8px; text-anchor: middle; }
  .bubble { fill: #14110f; font-size: 10px; font-weight: 700; }
  .banner { fill: #1a0b06; font-size: 11px; font-weight: 700; }
  .agent { cursor: pointer; outline: none; }
  .overlay { pointer-events: none; }
  .agent.paused image { filter: grayscale(1) brightness(.7); }
  .agent:focus-visible rect, .agent:hover image { filter: drop-shadow(0 0 3px #ffd23f); }
  @media (prefers-reduced-motion: no-preference) {
    .bob { animation: bob 2.4s ease-in-out infinite; }
    .typing { animation: typing .5s steps(2) infinite; }
    .screen { animation: flicker 3s steps(1) infinite; }
    .led { animation: blink 1.6s steps(1) infinite; }
    .fire { animation: fire .35s steps(1) infinite; transform-box: fill-box; transform-origin: bottom; }
    .steam { animation: steam 1.8s linear infinite; }
    .alarm-tint { animation: tint 1.6s ease-in-out infinite; }
    .arcade { animation: arcade 1.5s steps(3) infinite; }
  }
  @keyframes bob { 50% { transform: translateY(-3px); } }
  @keyframes typing { 50% { transform: translateY(1px); } }
  @keyframes flicker { 50% { opacity: .75; } }
  @keyframes blink { 50% { opacity: .2; } }
  @keyframes fire { 50% { transform: scaleY(.85) skewX(4deg); } }
  @keyframes steam { to { transform: translateY(-14px); opacity: 0; } }
  @keyframes tint { 50% { opacity: .3; } }
  @keyframes arcade { 33% { fill: #5e1b4a; } 66% { fill: #1b4a5e; } }
  .detail { display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px; border-top: 1px solid var(--divider-color); }
  .detail img { width: 40px; height: 40px; image-rendering: pixelated; }
  .detail > div { flex: 1; min-width: 0; }
  .who { font-weight: 600; } .who span { font-weight: 400; color: var(--secondary-text-color); font-size: .9em; }
  .doing { margin-top: 2px; } .last { margin-top: 4px; color: var(--secondary-text-color); font-size: .85em; }
  .detail button { background: none; border: 1px solid var(--divider-color); color: var(--primary-text-color); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  .strip { display: flex; align-items: center; gap: 8px; padding: 10px 12px; flex-wrap: wrap; }
  .mini { position: relative; background: none; border: 0; padding: 0; cursor: pointer; }
  .mini img { width: 36px; height: 36px; image-rendering: pixelated; display: block; }
  .mini.paused img { filter: grayscale(1) brightness(.7); }
  .mini .dot { position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border: 2px solid var(--card-background-color, #000); background: #6b6f8a; }
  .mini.working .dot { background: #4dff9a; } .mini.on_break .dot { background: #ffb547; }
  .counts { margin-left: 4px; color: var(--secondary-text-color); font-size: .9em; flex: 1; }
  .alarm-chip { font-size: .85em; padding: 2px 8px; border: 2px solid #4dff9a; color: #4dff9a; }
  .alarm-chip.on { border-color: #ff6b4a; color: #ff6b4a; }
</style>`;

if (!customElements.get("moss-basement-card")) {
  customElements.define("moss-basement-card", MossBasementCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "moss-basement-card",
    name: "MOSS Basement",
    description: "Your MOSS agents at their desks or on a break, live. Set compact: true for a one-line status strip.",
    preview: true,
  });
}
