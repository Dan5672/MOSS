"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { H, LEVELS, newGame, POWER_KINDS, POWER_TIME, startGame, step, W, type Game, type Input, type PowerKind, type Sound } from "./arcade-engine";

const HIGH_SCORE_KEY = "moss.arcade.highScore";
const GAME_KEYS = new Set(["ArrowLeft", "ArrowRight", "a", "A", "d", "D", " ", "Spacebar", "p", "P"]);

function readHigh() {
  try {
    return Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0;
  } catch {
    return 0;
  }
}
function saveHigh(n: number) {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(n));
  } catch {
    // Private windows can refuse storage; the high score just won't stick.
  }
}

// --- Sprites: one character per pixel. ------------------------------------------------------------

const PALETTE: Record<string, string> = {
  g: "#4dff9a",
  G: "#1f9e5a",
  w: "#e6dcc0",
  r: "#e0483e",
  o: "#ffb547",
  y: "#ffd23f",
  p: "#ff7ad9",
  b: "#3a5bd9",
  k: "#14110f",
  c: "#5ad1ff",
};
const SHIP = ["....w....", "...gwg...", "...ggg...", "..gGgGg..", ".ggGgGgg.", "ggggggggg", "g.g...g.g", "c.......c"];
const BUGS = [
  ["r.r...r.r", ".rrrrrrr.", "rrkrrrkrr", "rrrrrrrrr", ".r.r.r.r.", "r.......r"],
  ["...ooo...", "..ooooo..", ".okoooko.", "ooooooooo", ".o.o.o.o.", "o.......o"],
  ["p..ppp..p", ".ppppppp.", "ppkpppkpp", "ppppppppp", "..p.p.p..", ".p..p..p."],
];
const BOSS = [
  "......yyyyyyyy......",
  "...yyyyyyyyyyyyyy...",
  ".yyyyrrryyyyrrryyyy.",
  "yyyyrrkrryyrrkrryyyy",
  "yyyyyrrryyyyrrryyyyy",
  "yyyyyyyyyyyyyyyyyyyy",
  ".yy.yyyy.yy.yyyy.yy.",
  "y..y....y..y....y..y",
];
const BOSS_TINT = ["#ffd23f", "#ffb547", "#e0483e"];
const POWER_LOOK: Record<PowerKind, { letter: string; color: string; label: string }> = {
  double: { letter: "2", color: "#4dff9a", label: "2X SHOT" },
  speed: { letter: "S", color: "#ffd23f", label: "SPEED" },
  laser: { letter: "L", color: "#5ad1ff", label: "LASER" },
};
const BOMB = ["..k..", ".rrr.", "rrrrr", "rrwrr", ".rrr."];

function sprite(ctx: CanvasRenderingContext2D, rows: string[], cx: number, cy: number, scale = 1, tint?: string) {
  const w = rows[0]!.length * scale;
  const h = rows.length * scale;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === ".") continue;
      ctx.fillStyle = tint && ch === "y" ? tint : PALETTE[ch]!;
      ctx.fillRect(x0 + x * scale, y0 + y * scale, scale, scale);
    }
  });
}

function text(ctx: CanvasRenderingContext2D, font: string, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "center") {
  ctx.font = `${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** The canvas is drawn at 3x the game's size so text stays sharp; sprites stay blocky. */
const DPR = 3;

function draw(ctx: CanvasRenderingContext2D, g: Game, high: number, paused: boolean, font: string) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#0b0816";
  ctx.fillRect(0, 0, W, H);
  // Stars drift down: three layers at different speeds.
  for (let i = 0; i < 60; i++) {
    const layer = i % 3;
    const x = (i * 97) % W;
    const y = ((i * 53 + g.time * (12 + layer * 14)) % H) | 0;
    ctx.fillStyle = layer === 2 ? "#e6dcc0" : layer === 1 ? "#6b6f8a" : "#34385a";
    ctx.fillRect(x, y, 1, layer === 2 ? 2 : 1);
  }

  if (g.phase !== "title") {
    for (const e of g.enemies) sprite(ctx, BUGS[e.kind]!, e.x, e.y + (e.kind === 1 ? Math.sin(e.t * 8) : 0));
    if (g.boss) {
      sprite(ctx, BOSS, g.boss.x, g.boss.y, 2, BOSS_TINT[g.level]);
      ctx.fillStyle = "#34385a";
      ctx.fillRect(40, 14, W - 80, 4);
      ctx.fillStyle = "#e0483e";
      ctx.fillRect(40, 14, ((W - 80) * Math.max(0, g.boss.hp)) / g.boss.maxHp, 4);
      text(ctx, font, LEVELS[g.level]!.boss, W / 2, 21, 6, "#e6dcc0");
    }
    // The laser: a flickering beam from the ship to the top of the screen.
    if (g.power.laser > 0 && g.phase === "playing") {
      ctx.fillStyle = Math.floor(g.time * 30) % 2 ? "rgba(90,209,255,.55)" : "rgba(90,209,255,.8)";
      ctx.fillRect(g.player.x - 3, 0, 6, g.player.y - 6);
      ctx.fillStyle = "#e6f9ff";
      ctx.fillRect(g.player.x - 1, 0, 2, g.player.y - 6);
    }
    // Falling power-ups: a lettered box, blinking in their last stretch.
    for (const d of g.drops) {
      const look = POWER_LOOK[d.kind];
      ctx.fillStyle = "#14110f";
      ctx.fillRect(d.x - 6, d.y - 6, 12, 12);
      ctx.fillStyle = look.color;
      ctx.fillRect(d.x - 5, d.y - 5, 10, 10);
      text(ctx, font, look.letter, d.x, d.y - 3, 7, "#14110f");
    }
    ctx.fillStyle = "#4dff9a";
    for (const s of g.shots) ctx.fillRect(s.x - 1, s.y - 3, 2, 6);
    ctx.fillStyle = "#ff7ad9";
    for (const s of g.enemyShots) ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    // Blink while recovering from a hit.
    if (g.phase !== "over" && (g.player.invuln <= 0 || Math.floor(g.time * 12) % 2 === 0)) sprite(ctx, SHIP, g.player.x, g.player.y);
  }
  for (const s of g.sparks) {
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x, s.y, 2, 2);
  }

  // HUD
  text(ctx, font, `SCORE ${String(g.score).padStart(6, "0")}`, 6, 4, 7, "#e6dcc0", "left");
  text(ctx, font, `HI ${String(Math.max(high, g.score)).padStart(6, "0")}`, W - 6, 4, 7, "#ffd23f", "right");
  if (g.phase !== "title") {
    for (let i = 0; i < g.lives; i++) sprite(ctx, SHIP, 10 + i * 12, H - 7, 1);
    for (let i = 0; i < g.bombs; i++) sprite(ctx, BOMB, 64 + i * 12, H - 8, 2);
    text(ctx, font, `L${g.level + 1}`, W - 6, H - 11, 7, "#6b6f8a", "right");
    // Active power-ups and how long they have left.
    let y = 14;
    for (const k of POWER_KINDS) {
      if (g.power[k] <= 0) continue;
      const look = POWER_LOOK[k];
      ctx.fillStyle = look.color;
      ctx.fillRect(6, y + 1, 40 * (g.power[k] / POWER_TIME), 3);
      text(ctx, font, look.label, 50, y - 1, 6, look.color, "left");
      y += 9;
    }
  }
  if (g.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${Math.min(0.8, g.flash * 1.4)})`;
    ctx.fillRect(0, 0, W, H);
  }

  const centre = (lines: [string, number, string][]) => {
    let y = H / 2 - lines.length * 9;
    for (const [s, size, color] of lines) {
      text(ctx, font, s, W / 2, y, size, color);
      y += size + 9;
    }
  };
  if (g.phase === "title") {
    sprite(ctx, BOSS, W / 2, 70, 2);
    centre([
      ["PACKET STORM", 14, "#4dff9a"],
      ["Shoot the bugs before", 7, "#e6dcc0"],
      ["they reach your ship.", 7, "#e6dcc0"],
      ["Grab 2X, S and L power-ups.", 7, "#5ad1ff"],
      ["P pauses.", 7, "#6b6f8a"],
      [Math.floor(g.time * 2) % 2 ? "" : "PRESS SPACE", 9, "#ffd23f"],
    ]);
    text(ctx, font, "<- -> or A D: move", W / 2, H - 58, 7, "#6b6f8a");
    text(ctx, font, "Your ship fires itself", W / 2, H - 46, 7, "#6b6f8a");
    text(ctx, font, "SPACE: bomb (1 a level)", W / 2, H - 34, 7, "#6b6f8a");
    sprite(ctx, SHIP, W / 2, H - 16);
  } else if (g.phase === "banner") {
    centre([
      [LEVELS[g.level]!.name, 9, "#4dff9a"],
      ["GET READY", 8, "#e6dcc0"],
    ]);
  } else if (g.phase === "over") {
    centre([
      ["GAME OVER", 14, "#e0483e"],
      [g.score >= high && g.score > 0 ? "NEW HIGH SCORE!" : `SCORE ${g.score}`, 8, "#ffd23f"],
      ["SPACE to play again", 7, "#e6dcc0"],
    ]);
  } else if (g.phase === "won") {
    centre([
      ["NETWORK SECURED", 12, "#4dff9a"],
      ["All three bosses down.", 7, "#e6dcc0"],
      [g.score >= high ? "NEW HIGH SCORE!" : `SCORE ${g.score}`, 8, "#ffd23f"],
      ["SPACE to play again", 7, "#e6dcc0"],
    ]);
  }
  if (paused && g.phase !== "title") {
    ctx.fillStyle = "rgba(11,8,22,.7)";
    ctx.fillRect(0, 0, W, H);
    centre([
      ["PAUSED", 14, "#ffd23f"],
      ["P or SPACE to carry on", 7, "#e6dcc0"],
    ]);
  }
}

// --- Sound: synthesised blips, off until you switch it on. -----------------------------------------

function play(ctx: AudioContext, sound: Sound) {
  const t = ctx.currentTime;
  const tone = (type: OscillatorType, from: number, to: number, dur: number, vol = 0.05, at = 0) => {
    const o = ctx.createOscillator();
    const v = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t + at);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + at + dur);
    v.gain.setValueAtTime(vol, t + at);
    v.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
    o.connect(v).connect(ctx.destination);
    o.start(t + at);
    o.stop(t + at + dur + 0.02);
  };
  if (sound === "shoot") tone("square", 1200, 500, 0.07, 0.025);
  if (sound === "hit") tone("square", 300, 60, 0.12, 0.05);
  if (sound === "hurt") tone("triangle", 400, 60, 0.35, 0.08);
  if (sound === "boom") {
    tone("sawtooth", 160, 30, 0.6, 0.08);
    tone("square", 90, 25, 0.8, 0.05, 0.1);
  }
  if (sound === "boss") [220, 196, 175, 165].forEach((f, i) => tone("square", f, f, 0.14, 0.04, i * 0.15));
  if (sound === "level" || sound === "start") [523, 659, 784, 1047].forEach((f, i) => tone("square", f, f, 0.09, 0.035, i * 0.08));
  if (sound === "powerup") [660, 880, 1320].forEach((f, i) => tone("triangle", f, f * 1.2, 0.07, 0.05, i * 0.05));
  if (sound === "bomb") {
    tone("sawtooth", 220, 25, 1.0, 0.1);
    tone("square", 60, 20, 1.2, 0.07, 0.05);
  }
}

/**
 * The arcade cabinet: a modal with Packet Storm on its screen. Keys only drive the game while it's open,
 * and arrows and Space never scroll the page behind it. It pauses when closed or when the tab is hidden,
 * and closing returns you to exactly where you were.
 */
export function ArcadeGame({ open, onClose, returnFocus }: { open: boolean; onClose: () => void; returnFocus?: React.RefObject<HTMLElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<Game | null>(null);
  const input = useRef<Input>({ left: false, right: false, fire: false });
  const audio = useRef<AudioContext | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [high, setHigh] = useState(0);
  const [status, setStatus] = useState("");
  const soundOnRef = useRef(false);
  const pausedRef = useRef(false);
  const highRef = useRef(0);

  game.current ??= newGame();
  useEffect(() => {
    highRef.current = readHigh();
    setHigh(highRef.current);
  }, []);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Closing the cabinet pauses a game in progress.
  useEffect(() => {
    if (!open && game.current && (game.current.phase === "playing" || game.current.phase === "banner")) setPaused(true);
    if (!open) input.current = { left: false, right: false, fire: false };
  }, [open]);

  const restart = useCallback(() => {
    startGame(game.current!);
    setPaused(false);
    canvas.current?.focus();
  }, []);

  const toggleSound = () => {
    const on = !soundOnRef.current;
    soundOnRef.current = on;
    setSoundOn(on);
    // Audio starts only from this click, as browsers require.
    if (on && !audio.current) {
      try {
        audio.current = new AudioContext();
      } catch {
        audio.current = null;
      }
    }
    if (on) void audio.current?.resume();
    canvas.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const set = (e: KeyboardEvent, down: boolean) => {
      if (!GAME_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      // Captured at the window: the page behind (and the Basement's own key tricks) never see these.
      e.preventDefault();
      e.stopPropagation();
      const k = e.key;
      if (k === "ArrowLeft" || k === "a" || k === "A") input.current.left = down;
      else if (k === "ArrowRight" || k === "d" || k === "D") input.current.right = down;
      else if (k === " " || k === "Spacebar") {
        if (down && pausedRef.current) setPaused(false);
        else {
          input.current.fire = down;
          if (down && !e.repeat) input.current.tap = true;
        }
      } else if ((k === "p" || k === "P") && down && !e.repeat) {
        const g = game.current!;
        if (g.phase === "playing" || g.phase === "banner") setPaused((v) => !v);
      }
    };
    const onDown = (e: KeyboardEvent) => set(e, true);
    const onUp = (e: KeyboardEvent) => set(e, false);
    const onVisibility = () => {
      if (document.hidden) setPaused(true);
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    document.addEventListener("visibilitychange", onVisibility);

    const fontFamily = getComputedStyle(document.body).getPropertyValue("--font-press-start").trim() || "monospace";
    let last = performance.now();
    let frame = 0;
    let lastStatus = "";
    const tick = (now: number) => {
      const g = game.current!;
      const dt = (now - last) / 1000;
      last = now;
      const before = g.phase;
      if (!pausedRef.current) {
        step(g, dt, input.current);
        input.current.tap = false;
      }
      if (soundOnRef.current && audio.current) for (const s of g.sounds) play(audio.current, s);
      g.sounds = [];
      if ((g.phase === "over" || g.phase === "won") && before !== g.phase && g.score > highRef.current) {
        highRef.current = g.score;
        saveHigh(g.score);
        setHigh(g.score);
      }
      const ctx = canvas.current?.getContext("2d");
      if (ctx) draw(ctx, g, highRef.current, pausedRef.current, fontFamily);
      const s =
        g.phase === "title"
          ? "Packet Storm. Press Space to start."
          : g.phase === "over"
            ? `Game over. Score ${g.score}. Press Space to play again.`
            : g.phase === "won"
              ? `You won! Score ${g.score}. Press Space to play again.`
              : g.phase === "banner"
                ? `${LEVELS[g.level]!.name.replace(/\s+/g, " ")}. Get ready.`
                : g.boss
                  ? `Boss: ${LEVELS[g.level]!.boss}.`
                  : `Level ${g.level + 1}.`;
      if (s !== lastStatus) {
        lastStatus = s;
        setStatus(s);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      document.removeEventListener("visibilitychange", onVisibility);
      input.current = { left: false, right: false, fire: false };
    };
  }, [open]);

  useEffect(() => () => void audio.current?.close(), []);

  // On-screen buttons for touch screens.
  const hold = (key: "left" | "right" | "fire") => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      if (key === "fire" && pausedRef.current) setPaused(false);
      input.current[key] = true;
      if (key === "fire") input.current.tap = true;
    },
    onPointerUp: () => (input.current[key] = false),
    onPointerLeave: () => (input.current[key] = false),
    onPointerCancel: () => (input.current[key] = false),
  });

  const button = "grid size-11 place-items-center rounded-full border-4 border-[#0b0816] font-mono text-xs font-bold text-[#14110f] shadow-[inset_0_-4px_0_rgba(0,0,0,.3)] active:translate-y-0.5";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            canvas.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Back to the cabinet, without moving the page.
            if (!returnFocus?.current) return;
            e.preventDefault();
            returnFocus.current.focus({ preventScroll: true });
          }}
          className="fixed top-1/2 left-1/2 z-50 max-h-[100dvh] w-[min(30rem,calc(100vw-1rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto outline-none"
        >
          {/* The cabinet: marquee, bezel and screen, control panel. */}
          <div className="border-4 border-[#0b0816] bg-[#1d1640] p-3 shadow-[8px_8px_0_#0b0816]" style={{ clipPath: "polygon(4% 0, 96% 0, 100% 4%, 100% 100%, 0 100%, 0 4%)" }}>
            <div className="mb-3 border-4 border-[#0b0816] bg-[#2b1b5e] px-3 py-2 text-center shadow-[inset_0_0_12px_rgba(255,210,63,.35)]">
              <DialogPrimitive.Title className="font-pixel text-[15px] tracking-wider text-[#ffd23f] [text-shadow:2px_2px_0_#e0483e]">PACKET STORM</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 font-mono text-[11px] text-[#e6dcc0]">
                Move with ← → or A D · it fires by itself · Space drops a bomb · P pauses · Esc leaves
              </DialogPrimitive.Description>
            </div>
            <div className="rounded-[10px] border-[10px] border-[#0b0816] bg-black p-1 shadow-[inset_0_0_20px_#000]">
              <canvas
                ref={canvas}
                width={W * DPR}
                height={H * DPR}
                tabIndex={0}
                aria-label="Packet Storm game screen"
                aria-describedby="arcade-status"
                className="block aspect-[224/288] w-full outline-none [image-rendering:pixelated] focus-visible:ring-2 focus-visible:ring-[#ffd23f]"
              />
            </div>
            <p id="arcade-status" aria-live="polite" className="sr-only">
              {paused ? "Paused." : status}
            </p>
            <div className="mt-3 flex items-center justify-between gap-2 border-4 border-[#0b0816] bg-[#34405a] p-2">
              <div className="flex items-center gap-2" aria-hidden>
                <button type="button" tabIndex={-1} className={`${button} bg-[#e6dcc0]`} {...hold("left")}>
                  ◀
                </button>
                <button type="button" tabIndex={-1} className={`${button} bg-[#e6dcc0]`} {...hold("right")}>
                  ▶
                </button>
                <button type="button" tabIndex={-1} className={`${button} bg-[#e0483e]`} {...hold("fire")}>
                  BOMB
                </button>
              </div>
              <div className="grid gap-1.5 text-right">
                <span className="font-mono text-[11px] text-[#ffd23f]">HI {high}</span>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <button type="button" onClick={restart} className="border-2 border-[#0b0816] bg-[#ffd23f] px-2 py-1 font-mono text-xs text-[#14110f]">
                    Restart
                  </button>
                  <button type="button" onClick={toggleSound} aria-pressed={soundOn} className="border-2 border-[#0b0816] bg-[#e6dcc0] px-2 py-1 font-mono text-xs text-[#14110f]">
                    Sound {soundOn ? "on" : "off"}
                  </button>
                  <DialogPrimitive.Close className="border-2 border-[#0b0816] bg-[#e6dcc0] px-2 py-1 font-mono text-xs text-[#14110f]">Close</DialogPrimitive.Close>
                </div>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
