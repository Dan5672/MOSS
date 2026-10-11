"use client";

// The Basement's people: agents matched to desks (working) and spots (on a break), the desk fire while a
// monitor is down, and the same information as a list under the stage. The seat seed is fixed for the
// page visit, so the 15-second refreshes don't reshuffle anyone; a new visit may seat people differently.
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MascotSvg } from "@/components/mascot-svg";
import { agentGlow, agentMascot } from "@/lib/agent-look";
import { motionAllowed } from "@/lib/motion";
import { AgentPanelDialog } from "./agent-panel";
import { ArcadeGame } from "./arcade-game";
import { assign, CODE_LINES, DESKS, DOODLES, FIRE_MAPS, FIRE_PALETTE, KONAMI, shortName, SPOTS } from "./layout";

const STAGE_W = 1280;
const STAGE_H = 720;

/** Scales the fixed 1280×720 stage down to fit its container, so the page never scrolls sideways. */
function useStageScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / STAGE_W));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, scale };
}

/** Easter eggs: the coffee count, the whiteboard doodle, and a well-known cheat code that upsets the lights. */
function useEasterEggs() {
  const [pots, setPots] = useState(4);
  const [potBubble, setPotBubble] = useState(false);
  const [doodle, setDoodle] = useState(0);
  const [flicker, setFlicker] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setDoodle((d) => (d + 1) % DOODLES.length), 20_000);
    let progress = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // e.g. the arcade game has these keys
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      progress = key === KONAMI[progress] ? progress + 1 : key === KONAMI[0] ? 1 : 0;
      if (progress === KONAMI.length) {
        progress = 0;
        setFlicker(true);
        setTimeout(() => setFlicker(false), 4000);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const brew = () => {
    setPots((n) => n + 1);
    setPotBubble(true);
    setTimeout(() => setPotBubble(false), 2500);
  };
  return { pots, potBubble, brew, doodle: DOODLES[doodle]!, flicker };
}

const MONO = "var(--font-plex-mono), monospace";

export interface BasementAgent {
  id: string;
  name: string;
  title: string;
  templateKey: string | null;
  mascot: string | null;
  mascotGlow: string | null;
  working: boolean;
  trigger: string | null;
}

const DOING: Record<string, string> = {
  schedule: "On a recurring task",
  chat: "Answering a chat",
  ticket: "Working a ticket",
  event: "Handling an event",
  manual: "On a task you gave",
};

function useFireFrame(active: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active || !motionAllowed()) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % 2), 180);
    return () => clearInterval(timer);
  }, [active]);
  return frame;
}

export function BasementView({
  team,
  down,
  responderId,
  seed: initialSeed,
  furniture,
}: {
  team: BasementAgent[];
  down: { id: string; name: string }[];
  responderId: string | null;
  seed: number;
  furniture: ReactNode;
}) {
  // Fixed for this visit: later refreshes pass a new seed, but the first one is kept.
  const [seed] = useState(initialSeed);
  const alarm = down.length > 0;
  const responder = alarm ? team.find((a) => a.id === responderId) : undefined;
  const frame = useFireFrame(alarm);
  const { ref: stageBox, scale } = useStageScale();
  const egg = useEasterEggs();
  const [open, setOpen] = useState<string | null>(null);
  const [arcade, setArcade] = useState(false);
  const cabinet = useRef<HTMLButtonElement>(null);
  // Pester the cat five times in a row and someone sticks up for him.
  const catClicks = useRef({ n: 0, at: 0 });
  const [scolding, setScolding] = useState(false);
  const pokeCat = () => {
    const now = Date.now();
    const c = catClicks.current;
    c.n = now - c.at < 1500 ? c.n + 1 : 1;
    c.at = now;
    if (c.n >= 5) {
      c.n = 0;
      setScolding(true);
      setTimeout(() => setScolding(false), 3500);
    }
  };

  // The responder always works, and is seated first so they get a desk.
  const isWorking = (a: BasementAgent) => a.working || a.id === responder?.id;
  const busy = team.filter(isWorking).sort((a, b) => (a.id === responder?.id ? -1 : b.id === responder?.id ? 1 : 0));
  const idle = team.filter((a) => !isWorking(a));
  const seat = assign(busy.map((a) => a.id), DESKS.length, seed);
  const spot = assign(idle.map((a) => a.id), SPOTS.length, seed);
  const occupant = Object.fromEntries(Object.entries(seat).map(([id, i]) => [i, team.find((a) => a.id === id)!]));

  const summary = team.length
    ? `${team.length} agent${team.length === 1 ? "" : "s"}: ${Object.keys(seat).length} at desks, ${Object.keys(spot).length} on break.` +
      (alarm ? ` ${down[0]!.name} is down${responder ? `; ${responder.name} is responding` : ""}.` : "")
    : "The basement is empty: no agents yet.";

  // The cat's defender: someone on a break if there is one, otherwise whoever's at a desk.
  const defender = scolding ? (idle.find((a) => spot[a.id] !== undefined) ?? busy.find((a) => seat[a.id] !== undefined)) : undefined;

  const where = (a: BasementAgent) => {
    if (isWorking(a)) {
      const desk = seat[a.id] !== undefined ? `desk ${seat[a.id]! + 1}` : "No free desk";
      if (a.id === responder?.id) return `Responding to the alarm · ${desk}`;
      return `${DOING[a.trigger ?? ""] ?? "Working"} · ${desk}`;
    }
    return spot[a.id] !== undefined ? SPOTS[spot[a.id]!]!.text : "Wandering the corridor";
  };

  return (
    <div className="grid gap-6">
      <div ref={stageBox} className="px-frame overflow-hidden bg-terminal" style={{ height: STAGE_H * scale }}>
        <p className="sr-only">{summary} Select an agent to see what they&apos;re doing.</p>
        <div
          className={egg.flicker ? "b1-flicker" : undefined}
          style={{
            position: "relative",
            width: STAGE_W,
            height: STAGE_H,
            overflow: "hidden",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            margin: scale < 1 ? 0 : "0 auto",
            background: "#18201c",
            backgroundImage: "linear-gradient(#121815 2px, transparent 2px), linear-gradient(90deg, #121815 2px, transparent 2px)",
            backgroundSize: "48px 24px, 48px 48px",
          }}
        >
          <div aria-hidden>{furniture}</div>

          {DESKS.map((d, i) => {
            const a = occupant[i];
            const fire = !!(a && a.id === responder?.id);
            return (
              <div key={i} aria-hidden style={{ position: "absolute", left: d.x, top: d.top, width: 150, height: 95, zIndex: d.z }}>
                <div style={{ position: "absolute", left: 0, top: 0, width: 150, height: 14, background: "#8a6440", borderBottom: "4px solid #4a3220" }} />
                <div style={{ position: "absolute", left: 8, top: 18, width: 134, height: 72, background: "#5c4129", border: "4px solid #3d2a1a", boxSizing: "border-box", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 8 }}>
                  <div style={{ background: "#14110f", padding: "3px 8px", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: "#e6dcc0" }}>{a ? shortName(a.name) : `DESK ${i + 1}`}</span>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: fire ? "#ff6b4a" : a ? "#4dff9a" : "#8a9e94" }}>{fire ? "ON FIRE" : a ? "IN USE" : "FREE"}</span>
                  </div>
                </div>
                {/* Monitor: scrolling code in the occupant's glow, or a screensaver */}
                <div style={{ position: "absolute", left: 40, top: -52, width: 58, height: 52, background: "#d9cfb4", border: "3px solid #14110f", boxSizing: "border-box", padding: 5, overflow: "hidden" }}>
                  <div style={{ width: "100%", height: "100%", background: "#0e2a20", overflow: "hidden", position: "relative" }}>
                    {a ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: 3, animation: "b1-scrollcode 3s linear infinite" }}>
                        {CODE_LINES.map((w, j) => (
                          <span key={j} style={{ height: 2, width: `${w}%`, background: agentGlow(a), flexShrink: 0 }} />
                        ))}
                      </div>
                    ) : (
                      <span style={{ position: "absolute", left: 2, top: 2, width: 7, height: 7, background: "#4dff9a", opacity: 0.4, animation: "b1-saver 6s steps(8) infinite" }} />
                    )}
                  </div>
                </div>
                <div style={{ position: "absolute", left: 62, top: -4, width: 16, height: 4, background: "#14110f" }} />
                <div style={{ position: "absolute", left: 104, top: -6, width: 38, height: 6, background: "#e6dcc0", border: "2px solid #14110f", boxSizing: "border-box" }} />
                {d.mess && !fire && (
                  <>
                    <span style={{ position: "absolute", left: 6, top: -10, width: 30, height: 10, background: "#f5f1e6", border: "2px solid #14110f", boxSizing: "border-box" }} />
                    <span style={{ position: "absolute", left: 10, top: -18, width: 24, height: 8, background: "#e6dcc0", border: "2px solid #14110f", boxSizing: "border-box", transform: "rotate(-6deg)" }} />
                  </>
                )}
                {d.pizza && !fire && <span style={{ position: "absolute", left: 2, top: -8, width: 38, height: 8, background: "#c08a4a", border: "2px solid #5e4024", boxSizing: "border-box" }} />}
                {d.mug && <span style={{ position: "absolute", left: 140, top: -14, width: 12, height: 14, background: d.mugColor ?? "#f5f1e6", border: "2px solid #14110f", boxSizing: "border-box" }} />}
                {fire && (
                  <>
                    <div style={{ position: "absolute", left: 2, top: -48, width: 36, height: 48, display: "grid", gridTemplateColumns: "repeat(6, 6px)", gridAutoRows: "6px", zIndex: 2 }}>
                      {FIRE_MAPS[frame]!.flatMap((row, y) => [...row].map((ch, x) => <span key={`${x}-${y}`} style={{ background: FIRE_PALETTE[ch] }} />))}
                    </div>
                    <span style={{ position: "absolute", left: 14, top: -60, width: 10, height: 10, background: "rgba(120,120,120,.6)", animation: "b1-smoke 2s linear infinite" }} />
                    <span style={{ position: "absolute", left: 20, top: -56, width: 8, height: 8, background: "rgba(120,120,120,.5)", animation: "b1-smoke 2s linear infinite .8s" }} />
                    <span style={{ position: "absolute", left: 8, top: -58, width: 7, height: 7, background: "rgba(120,120,120,.5)", animation: "b1-smoke 2s linear infinite 1.4s" }} />
                  </>
                )}
              </div>
            );
          })}

          {team.map((a) => {
            const deskIndex = isWorking(a) ? seat[a.id] : undefined;
            const spotIndex = !isWorking(a) ? spot[a.id] : undefined;
            if (deskIndex === undefined && spotIndex === undefined) return null;
            const d = deskIndex !== undefined ? DESKS[deskIndex]! : undefined;
            const p = spotIndex !== undefined ? SPOTS[spotIndex]! : undefined;
            const responding = a.id === responder?.id;
            const pos: CSSProperties = d ? { left: d.x + 72, top: d.top - 50, zIndex: d.cz } : { left: p!.x, top: p!.y, zIndex: p!.z };
            const bubble = a.id === defender?.id ? "Leave him alone!" : d ? (responding ? "ON IT!" : null) : p!.bubble;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setOpen(a.id)}
                aria-label={`${a.name}: ${where(a)}. Show what they're doing`}
                title={`${a.name}: ${where(a)}`}
                className="b1-agent"
                style={{ position: "absolute", width: 80, height: 80, padding: 0, border: 0, background: "none", cursor: "pointer", ...pos }}
              >
                {/* The button stays still; only what's inside it bobs or types. */}
                <span className={d ? "b1-typing" : "b1-bob"} style={{ display: "block", position: "relative", width: 80, height: 80 }}>
                {bubble && (
                  <span
                    style={{
                      display: "block",
                      position: "absolute",
                      left: "50%",
                      bottom: 88,
                      transform: "translateX(-50%)",
                      whiteSpace: "nowrap",
                      background: d ? "#ff6b4a" : "#e6dcc0",
                      color: "#14110f",
                      fontFamily: MONO,
                      fontSize: 11,
                      fontWeight: 500,
                      padding: "3px 7px",
                      border: "2px solid #14110f",
                    }}
                  >
                    {bubble}
                  </span>
                )}
                <MascotSvg variant={agentMascot(a)} size={80} glow={agentGlow(a)} />
                {p?.book && <span style={{ position: "absolute", left: 18, top: 56, width: 44, height: 24, background: "#e0483e", border: "3px solid #14110f", boxSizing: "border-box" }} />}
                {p?.pad && <span style={{ position: "absolute", left: 22, top: 62, width: 36, height: 14, background: "#2b2b2b", border: "2px solid #14110f", boxSizing: "border-box" }} />}
                {p?.mug && <span style={{ position: "absolute", left: 54, top: 58, width: 14, height: 16, background: "#f5f1e6", border: "2px solid #14110f", boxSizing: "border-box" }} />}
                {p?.cable && (
                  <>
                    <span style={{ position: "absolute", left: 10, top: 54, width: 60, height: 26, border: "4px solid #ffb547", borderRadius: "50%", boxSizing: "border-box" }} />
                    <span style={{ position: "absolute", left: 20, top: 60, width: 44, height: 18, border: "3px solid #3a5bd9", borderRadius: "50%", boxSizing: "border-box" }} />
                  </>
                )}
                {p?.crt && (
                  <span style={{ position: "absolute", left: 14, top: 46, width: 52, height: 34, background: "#d9cfb4", border: "3px solid #14110f", boxSizing: "border-box", padding: 4 }}>
                    <span style={{ display: "block", width: "100%", height: "100%", background: "#4dff9a", opacity: 0.5 }} />
                  </span>
                )}
                </span>
              </button>
            );
          })}

          {/* NPCs: a cat asleep on the middle rack, and a robot vacuum doing its rounds. */}
          <button
            type="button"
            onClick={pokeCat}
            aria-label="Kernel, the office cat. Asleep on the warm rack, as usual."
            title="Kernel, the office cat. Asleep on the warm rack, as usual."
            style={{ position: "absolute", left: 142, top: 140, width: 52, height: 32, zIndex: 3, padding: 0, border: 0, background: "none", cursor: "pointer" }}
          >
            <span className="b1-tail" style={{ position: "absolute", left: 40, top: 14, width: 16, height: 6, background: "#e08a3a", border: "2px solid #14110f", transformOrigin: "left center" }} />
            <span style={{ position: "absolute", left: 4, top: 12, width: 40, height: 20, background: "#e08a3a", border: "3px solid #14110f", borderRadius: "10px 10px 2px 2px" }} />
            <span style={{ position: "absolute", left: 14, top: 14, width: 8, height: 4, background: "#b8642a" }} />
            <span style={{ position: "absolute", left: 26, top: 18, width: 8, height: 4, background: "#b8642a" }} />
            <span style={{ position: "absolute", left: 0, top: 6, width: 18, height: 16, background: "#e08a3a", border: "3px solid #14110f", borderRadius: 3 }} />
            <span style={{ position: "absolute", left: 1, top: 0, width: 6, height: 8, background: "#e08a3a", borderLeft: "3px solid #14110f", borderTop: "3px solid #14110f" }} />
            <span style={{ position: "absolute", left: 10, top: 0, width: 6, height: 8, background: "#e08a3a", borderRight: "3px solid #14110f", borderTop: "3px solid #14110f" }} />
            <span style={{ position: "absolute", left: 4, top: 13, width: 4, height: 2, background: "#14110f" }} />
            <span style={{ position: "absolute", left: 11, top: 13, width: 4, height: 2, background: "#14110f" }} />
            <span className={scolding ? undefined : "b1-zzz"} style={{ position: "absolute", left: 18, top: -14, fontFamily: MONO, fontSize: 10, color: "#e6dcc0" }}>
              {scolding ? "!" : "z"}
            </span>
          </button>
          {scolding && !defender && (
            <span aria-hidden style={{ position: "absolute", left: 120, top: 104, zIndex: 10, background: "#e6dcc0", color: "#14110f", fontFamily: MONO, fontSize: 11, fontWeight: 500, padding: "3px 7px", border: "2px solid #14110f" }}>
              HSSS!
            </span>
          )}
          <span aria-live="polite" className="sr-only">
            {scolding ? `${defender ? defender.name : "Kernel"}: ${defender ? "Leave him alone!" : "Hsss!"}` : ""}
          </span>

          {/* Double-click the arcade cabinet to play. (Keyboard: Enter.) */}
          <button
            ref={cabinet}
            type="button"
            onDoubleClick={() => setArcade(true)}
            onClick={(e) => e.detail === 0 && setArcade(true)}
            aria-label="Arcade cabinet: play Packet Storm"
            title="Arcade cabinet. Double-click to play."
            className="b1-agent"
            style={{ position: "absolute", left: 1180, top: 300, width: 84, height: 220, zIndex: 4, padding: 0, border: 0, background: "none", cursor: "pointer" }}
          />
          <div aria-hidden className="b1-vacuum" title="The robot vacuum. It has opinions about cables." style={{ position: "absolute", left: 300, top: 700, width: 40, height: 14, zIndex: 8 }}>
            <span style={{ position: "absolute", inset: 0, background: "#3b4450", border: "3px solid #14110f", borderRadius: "12px 12px 4px 4px" }} />
            <span className="b1-led" style={{ position: "absolute", left: 16, top: 3, width: 6, height: 3, background: "#4dff9a" }} />
          </div>

          {/* Easter eggs: a rubber duck, the whiteboard's latest doodle, and the coffee machine. */}
          <span aria-hidden title="Rubber duck. Explain the bug to it out loud; it's a great listener." style={{ position: "absolute", left: 872, top: 522, width: 18, height: 16, zIndex: 4 }}>
            <span style={{ position: "absolute", left: 0, top: 6, width: 16, height: 10, background: "#ffd23f", border: "2px solid #14110f", borderRadius: "2px 2px 6px 6px" }} />
            <span style={{ position: "absolute", left: 8, top: 0, width: 9, height: 8, background: "#ffd23f", border: "2px solid #14110f", borderRadius: 3 }} />
            <span style={{ position: "absolute", left: 16, top: 3, width: 5, height: 3, background: "#ff8a3a" }} />
          </span>
          <span aria-hidden style={{ position: "absolute", left: 678, top: 318, fontFamily: MONO, fontSize: 12, color: "#e0483e", whiteSpace: "nowrap" }}>
            {egg.flicker ? "↑↑↓↓←→←→BA" : egg.doodle}
          </span>
          <button
            type="button"
            onClick={egg.brew}
            aria-label={`Coffee machine: ${egg.pots} pots brewed today. Brew another`}
            title="Coffee machine"
            className="b1-agent"
            style={{ position: "absolute", left: 58, top: 540, width: 50, height: 60, zIndex: 6, padding: 0, border: 0, background: "none", cursor: "pointer" }}
          />
          {egg.potBubble && (
            <span aria-hidden style={{ position: "absolute", left: 40, top: 500, zIndex: 10, background: "#e6dcc0", color: "#14110f", fontFamily: MONO, fontSize: 11, fontWeight: 500, padding: "3px 7px", border: "2px solid #14110f" }}>
              pot #{egg.pots}
            </span>
          )}
          <span aria-live="polite" className="sr-only">
            {egg.potBubble ? `Pot number ${egg.pots} is brewing.` : ""}
          </span>

          {alarm && (
            <>
              <div aria-hidden style={{ position: "absolute", inset: 0, background: "rgba(255,60,40,.10)", pointerEvents: "none", zIndex: 9, animation: "b1-alarmtint 1.6s ease-in-out infinite" }} />
              <div aria-hidden style={{ position: "absolute", left: 24, top: 92, zIndex: 10, background: "#ff6b4a", color: "#1a0b06", fontFamily: MONO, fontSize: 13, fontWeight: 500, padding: "6px 12px" }}>
                MONITOR {down[0]!.name.toUpperCase()} · DOWN{responder ? ` · ${responder.name.toUpperCase()} RESPONDING` : ""}
              </div>
            </>
          )}
        </div>
      </div>

      <AgentPanelDialog agentId={open} onClose={() => setOpen(null)} />
      <ArcadeGame open={arcade} onClose={() => setArcade(false)} returnFocus={cabinet} />

      <section aria-labelledby="basement-who" className="grid gap-3">
        <h2 id="basement-who" className="text-base font-semibold text-ink dark:text-beige">
          Who&apos;s where
        </h2>
        {team.length === 0 ? (
          <p className="border-2 border-dashed p-8 text-center font-mono text-sm text-muted-foreground">
            No agents yet. <Link href="/agents" className="underline">Hire one</Link> and they&apos;ll turn up here.
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3">
            {team.map((a) => (
              <li key={a.id} className="px-frame flex items-center gap-3 bg-card p-3">
                <MascotSvg variant={agentMascot(a)} size={48} glow={agentGlow(a)} className="shrink-0" />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <Link href={`/agents/${a.id}`} className="truncate text-sm font-semibold hover:underline">
                    {a.name}
                  </Link>
                  <span className="truncate text-xs text-muted-foreground">{where(a)}</span>
                </div>
                <span className={`font-mono text-xs ${a.id === responder?.id ? "text-alarm" : isWorking(a) ? "text-phosphor" : "text-dim"}`}>
                  {a.id === responder?.id ? "RESPONDING" : isWorking(a) ? "WORKING" : "ON BREAK"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
