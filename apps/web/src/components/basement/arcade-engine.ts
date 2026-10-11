// Packet Storm: the basement arcade's game. A small ship at the bottom fires on its own at falling bugs
// before they reach it; three levels, each ending with a boss. Bugs sometimes drop power-ups, and each
// level gives you one bomb. Pure logic (no DOM), stepped by the arcade modal.

export const W = 224;
export const H = 288;

export type Phase = "title" | "banner" | "playing" | "over" | "won";
export type Sound = "shoot" | "hit" | "boom" | "hurt" | "boss" | "level" | "start" | "powerup" | "bomb";
export interface Input {
  left: boolean;
  right: boolean;
  /** Space: starts the game, then drops the bomb. (Firing is automatic.) */
  fire: boolean;
  /** Space was pressed since the last step, even if already let go: a quick tap still counts. */
  tap?: boolean;
}

/** Power-ups: double shot, speed (moves and fires faster) and a laser beam. Each lasts POWER_TIME. */
export type PowerKind = "double" | "speed" | "laser";
export const POWER_KINDS: PowerKind[] = ["double", "speed", "laser"];
export const POWER_TIME = 8;
const DROP_CHANCE = 0.12;
export interface Drop {
  x: number;
  y: number;
  kind: PowerKind;
}

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
}
export interface Enemy {
  x: number;
  y: number;
  vy: number;
  kind: 0 | 1 | 2; // 0 falls straight, 1 zigzags, 2 shoots
  hp: number;
  t: number;
  fireIn: number;
}
export interface Boss {
  x: number;
  y: number;
  vx: number;
  hp: number;
  maxHp: number;
  t: number;
  fireIn: number;
}
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export interface Level {
  name: string;
  boss: string;
  enemies: number;
  spawnEvery: number;
  speed: [number, number];
  zigzag: number;
  shooters: number;
  bossHp: number;
  bossFireEvery: number;
  bossSpread: number;
}

export const LEVELS: Level[] = [
  { name: "LEVEL 1  THE LAN", boss: "THE BROADCAST STORM", enemies: 16, spawnEvery: 0.95, speed: [32, 46], zigzag: 0, shooters: 0, bossHp: 36, bossFireEvery: 1.1, bossSpread: 1 },
  { name: "LEVEL 2  THE DMZ", boss: "THE ROGUE DHCP", enemies: 22, spawnEvery: 0.8, speed: [40, 58], zigzag: 0.4, shooters: 0.15, bossHp: 56, bossFireEvery: 1.1, bossSpread: 3 },
  { name: "LEVEL 3  THE CORE", boss: "THE ZERO-DAY", enemies: 28, spawnEvery: 0.65, speed: [48, 72], zigzag: 0.4, shooters: 0.3, bossHp: 80, bossFireEvery: 0.9, bossSpread: 5 },
];

export interface Game {
  phase: Phase;
  level: number;
  score: number;
  lives: number;
  time: number;
  player: { x: number; y: number; cooldown: number; invuln: number };
  shots: Bullet[];
  enemyShots: Bullet[];
  enemies: Enemy[];
  boss: Boss | null;
  sparks: Spark[];
  drops: Drop[];
  /** Seconds left on each power-up. */
  power: Record<PowerKind, number>;
  /** Bombs left this level (one per level). */
  bombs: number;
  /** A bomb's white flash, fading out. */
  flash: number;
  laserTick: number;
  toSpawn: number;
  spawnIn: number;
  bannerFor: number;
  /** Sounds to play this frame; the modal drains it. */
  sounds: Sound[];
  rng: number;
  fireHeld: boolean;
}

const PLAYER_Y = H - 26;

export function newGame(seed = Date.now() % 2 ** 31): Game {
  return {
    phase: "title",
    level: 0,
    score: 0,
    lives: 3,
    time: 0,
    player: { x: W / 2, y: PLAYER_Y, cooldown: 0, invuln: 0 },
    shots: [],
    enemyShots: [],
    enemies: [],
    boss: null,
    sparks: [],
    drops: [],
    power: { double: 0, speed: 0, laser: 0 },
    bombs: 1,
    flash: 0,
    laserTick: 0,
    toSpawn: 0,
    spawnIn: 0,
    bannerFor: 0,
    sounds: [],
    rng: seed || 1,
    fireHeld: true, // a held Space from opening the game doesn't start it
  };
}

/** mulberry32: small, seeded, good enough for a game. */
function rand(g: Game) {
  g.rng = (g.rng + 0x6d2b79f5) | 0;
  let t = g.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function beginLevel(g: Game, level: number) {
  g.level = level;
  g.phase = "banner";
  g.bannerFor = 2;
  g.toSpawn = LEVELS[level]!.enemies;
  g.spawnIn = 0.6;
  g.enemies = [];
  g.shots = [];
  g.enemyShots = [];
  g.drops = [];
  g.boss = null;
  g.bombs = 1;
  g.sounds.push(level === 0 ? "start" : "level");
}

/** From the title (or after the game ends): a fresh game at level 1. */
export function startGame(g: Game) {
  const fresh = newGame(g.rng);
  Object.assign(g, fresh, { fireHeld: true });
  beginLevel(g, 0);
}

const hit = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
  Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;

function burst(g: Game, x: number, y: number, color: string, n: number) {
  for (let i = 0; i < n; i++) {
    const a = rand(g) * Math.PI * 2;
    const s = 20 + rand(g) * 70;
    g.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + rand(g) * 0.4, color });
  }
}

/** A bug destroyed: score, sparks, and now and then a power-up falls from it. */
function killEnemy(g: Game, e: Enemy) {
  e.hp = 0;
  g.score += 100 * (g.level + 1);
  g.sounds.push("hit");
  burst(g, e.x, e.y, e.kind === 2 ? "#ff7ad9" : e.kind === 1 ? "#ffb547" : "#e0483e", 8);
  if (rand(g) < DROP_CHANCE) g.drops.push({ x: e.x, y: e.y, kind: POWER_KINDS[Math.floor(rand(g) * POWER_KINDS.length)]! });
}

/** The bomb: every bug on screen and every shot coming at you is gone, and the boss takes a quarter of its health. */
function dropBomb(g: Game) {
  if (g.bombs <= 0) return;
  g.bombs -= 1;
  g.flash = 0.6;
  g.sounds.push("bomb");
  for (const e of g.enemies) if (e.hp > 0) killEnemy(g, e);
  g.enemies = [];
  g.enemyShots = [];
  if (g.boss && g.boss.y >= 20) {
    g.boss.hp -= Math.ceil(g.boss.maxHp / 4);
    burst(g, g.boss.x, g.boss.y, "#ffd23f", 16);
  }
}

function hurtPlayer(g: Game) {
  if (g.player.invuln > 0) return;
  g.lives -= 1;
  g.player.invuln = 2;
  g.sounds.push("hurt");
  burst(g, g.player.x, g.player.y, "#4dff9a", 14);
  if (g.lives <= 0) g.phase = "over";
}

export function step(g: Game, dt: number, input: Input) {
  dt = Math.min(dt, 1 / 20); // a dropped frame shouldn't teleport anything
  g.time += dt;
  const pressed = (input.fire && !g.fireHeld) || !!input.tap;
  g.fireHeld = input.fire;
  g.flash = Math.max(0, g.flash - dt);

  for (const s of g.sparks) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= dt;
  }
  g.sparks = g.sparks.filter((s) => s.life > 0);

  if (g.phase === "title" || g.phase === "over" || g.phase === "won") {
    if (pressed) startGame(g);
    return;
  }

  // The ship moves during the level banner too.
  const p = g.player;
  const speed = g.power.speed > 0 ? 1.6 : 1;
  p.x = Math.max(8, Math.min(W - 8, p.x + ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 120 * speed * dt));
  p.cooldown -= dt;
  p.invuln = Math.max(0, p.invuln - dt);
  if (g.phase === "banner") {
    g.bannerFor -= dt;
    if (g.bannerFor <= 0) g.phase = "playing";
    return;
  }

  const L = LEVELS[g.level]!;
  for (const k of POWER_KINDS) g.power[k] = Math.max(0, g.power[k] - dt);
  if (pressed) dropBomb(g);

  // Firing is automatic: the laser while it lasts, otherwise shots (two at a time with double shot).
  if (g.power.laser > 0) {
    g.laserTick -= dt;
    if (g.laserTick <= 0) {
      g.laserTick = 0.06;
      for (const e of g.enemies) if (e.hp > 0 && Math.abs(e.x - p.x) < 8 && e.y < p.y) (e.hp -= 1) <= 0 && killEnemy(g, e);
      const boss = g.boss;
      if (boss && boss.y >= 20 && Math.abs(boss.x - p.x) < 22) {
        boss.hp -= 1;
        g.score += 10;
        burst(g, p.x, boss.y + 10, "#5ad1ff", 1);
      }
    }
  } else if (p.cooldown <= 0) {
    if (g.power.double > 0) g.shots.push({ x: p.x - 4, y: p.y - 8, vx: 0, vy: -240 }, { x: p.x + 4, y: p.y - 8, vx: 0, vy: -240 });
    else g.shots.push({ x: p.x, y: p.y - 8, vx: 0, vy: -240 });
    p.cooldown = g.power.speed > 0 ? 0.1 : 0.2;
    g.sounds.push("shoot");
  }

  // Power-ups fall; fly into one to pick it up.
  for (const d of g.drops) d.y += 50 * dt;
  for (const d of g.drops) {
    if (hit(d.x, d.y, 10, 10, p.x, p.y, 12, 10)) {
      g.power[d.kind] = POWER_TIME;
      g.sounds.push("powerup");
      burst(g, d.x, d.y, "#5ad1ff", 10);
      d.y = H + 100;
    }
  }
  g.drops = g.drops.filter((d) => d.y < H + 8);

  // Spawn the level's bugs, then its boss.
  if (g.toSpawn > 0) {
    g.spawnIn -= dt;
    if (g.spawnIn <= 0) {
      const r = rand(g);
      const kind: Enemy["kind"] = r < L.shooters ? 2 : r < L.shooters + L.zigzag ? 1 : 0;
      g.enemies.push({ x: 14 + rand(g) * (W - 28), y: -10, vy: L.speed[0] + rand(g) * (L.speed[1] - L.speed[0]), kind, hp: kind === 2 ? 2 : 1, t: rand(g) * 6, fireIn: 0.8 + rand(g) * 1.2 });
      g.toSpawn -= 1;
      g.spawnIn = L.spawnEvery * (0.6 + rand(g) * 0.8);
    }
  } else if (!g.boss && g.enemies.length === 0) {
    g.boss = { x: W / 2, y: -24, vx: 40 + g.level * 12, hp: L.bossHp, maxHp: L.bossHp, t: 0, fireIn: 1.5 };
    g.sounds.push("boss");
  }

  for (const e of g.enemies) {
    e.t += dt;
    e.y += e.vy * dt;
    if (e.kind === 1) e.x = Math.max(8, Math.min(W - 8, e.x + Math.sin(e.t * 3) * 50 * dt));
    if (e.kind === 2) {
      e.fireIn -= dt;
      if (e.fireIn <= 0 && e.y < p.y - 40) {
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const d = Math.hypot(dx, dy) || 1;
        g.enemyShots.push({ x: e.x, y: e.y + 5, vx: (dx / d) * 90, vy: (dy / d) * 90 });
        e.fireIn = 1.4 + rand(g);
      }
    }
  }
  // Bugs that get past are gone; only touching the ship hurts.
  g.enemies = g.enemies.filter((e) => e.y < H + 10);

  const b = g.boss;
  if (b) {
    b.t += dt;
    if (b.y < 44) b.y += 30 * dt;
    else {
      b.x += b.vx * dt;
      if (b.x < 28 || b.x > W - 28) {
        b.vx = -b.vx;
        b.x = Math.max(28, Math.min(W - 28, b.x));
      }
      b.fireIn -= dt;
      if (b.fireIn <= 0) {
        const n = L.bossSpread;
        for (let i = 0; i < n; i++) {
          const a = Math.PI / 2 + (i - (n - 1) / 2) * 0.28;
          g.enemyShots.push({ x: b.x, y: b.y + 10, vx: Math.cos(a) * 100, vy: Math.sin(a) * 100 });
        }
        // The last level also aims one straight at you.
        if (g.level === 2) {
          const dx = p.x - b.x;
          const dy = p.y - b.y;
          const d = Math.hypot(dx, dy) || 1;
          g.enemyShots.push({ x: b.x, y: b.y + 10, vx: (dx / d) * 120, vy: (dy / d) * 120 });
        }
        b.fireIn = L.bossFireEvery * (b.hp < b.maxHp / 3 ? 0.7 : 1);
      }
    }
  }

  for (const s of [...g.shots, ...g.enemyShots]) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
  }
  g.enemyShots = g.enemyShots.filter((s) => s.y < H + 6 && s.x > -6 && s.x < W + 6);

  // Your shots against bugs and the boss.
  const spent = new Set<Bullet>();
  for (const s of g.shots) {
    if (s.y < -6) {
      spent.add(s);
      continue;
    }
    const e = g.enemies.find((e) => e.hp > 0 && hit(s.x, s.y, 2, 6, e.x, e.y, 12, 10));
    if (e) {
      spent.add(s);
      e.hp -= 1;
      if (e.hp <= 0) killEnemy(g, e);
      continue;
    }
    if (b && b.y >= 20 && hit(s.x, s.y, 2, 6, b.x, b.y, 44, 20)) {
      spent.add(s);
      b.hp -= 1;
      g.score += 10;
      burst(g, s.x, s.y, "#ffd23f", 2);
    }
  }
  g.shots = g.shots.filter((s) => !spent.has(s));
  g.enemies = g.enemies.filter((e) => e.hp > 0);

  if (b && b.hp <= 0) {
    g.score += 2000 * (g.level + 1);
    g.sounds.push("boom");
    burst(g, b.x, b.y, "#ffd23f", 30);
    burst(g, b.x, b.y, "#e0483e", 20);
    g.boss = null;
    g.enemyShots = [];
    if (g.level < LEVELS.length - 1) beginLevel(g, g.level + 1);
    else {
      g.phase = "won";
      g.score += 1000 * g.lives;
    }
    return;
  }

  // Things that hit you.
  for (const s of g.enemyShots) {
    if (hit(s.x, s.y, 3, 3, p.x, p.y, 10, 8)) {
      s.y = H + 100;
      hurtPlayer(g);
    }
  }
  for (const e of g.enemies) {
    if (hit(e.x, e.y, 12, 10, p.x, p.y, 12, 10)) {
      e.hp = 0;
      burst(g, e.x, e.y, "#e0483e", 8);
      hurtPlayer(g);
    }
  }
  g.enemies = g.enemies.filter((e) => e.hp > 0);
  if (b && hit(b.x, b.y, 44, 20, p.x, p.y, 12, 10)) hurtPlayer(g);
}
