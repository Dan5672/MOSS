import { describe, expect, it } from "vitest";
import { H, LEVELS, newGame, step, type Game } from "./arcade-engine";

const idle = { left: false, right: false, fire: false };
const fire = { left: false, right: false, fire: true };
const run = (g: Game, seconds: number, input = idle) => {
  for (let t = 0; t < seconds; t += 1 / 60) step(g, 1 / 60, input);
};
/** Past the title and the level banner. */
function playing() {
  const g = newGame(7);
  step(g, 1 / 60, idle);
  step(g, 1 / 60, fire);
  run(g, 2.1);
  return g;
}

describe("Packet Storm", () => {
  it("starts on a fresh press of Space, not one held from before", () => {
    const g = newGame(1);
    run(g, 0.5, fire);
    expect(g.phase).toBe("title");
    step(g, 1 / 60, idle);
    step(g, 1 / 60, fire);
    expect(g).toMatchObject({ phase: "banner", level: 0, lives: 3, score: 0 });
    expect(g.sounds).toContain("start");
    run(g, 2.1);
    expect(g.phase).toBe("playing");
    // A tap shorter than a frame still fires.
    g.shots = [];
    step(g, 1 / 60, { ...idle, tap: true });
    expect(g.shots).toHaveLength(1);
  });

  it("moves within the screen and fires at a steady rate", () => {
    const g = playing();
    run(g, 3, { left: true, right: false, fire: false });
    expect(g.player.x).toBe(8);
    g.shots = [];
    run(g, 1, fire);
    expect(g.shots.length).toBeGreaterThanOrEqual(4);
    expect(g.shots.length).toBeLessThanOrEqual(6);
  });

  it("shooting a bug scores, and the boss comes once the level's bugs are gone", () => {
    const g = playing();
    g.enemies = [{ x: g.player.x, y: 120, vy: 0, kind: 0, hp: 1, t: 0, fireIn: 9 }];
    g.toSpawn = 0;
    run(g, 1, fire);
    expect(g.score).toBe(100);
    run(g, 0.1);
    expect(g.boss).toMatchObject({ hp: LEVELS[0]!.bossHp });
  });

  it("beating each boss moves to the next level, and the third wins the game", () => {
    const g = playing();
    for (let level = 0; level < 3; level++) {
      expect(g.level).toBe(level);
      g.toSpawn = 0;
      g.enemies = [];
      run(g, 0.05);
      g.boss!.hp = 1;
      g.boss!.y = 44;
      g.shots = [{ x: g.boss!.x, y: g.boss!.y, vx: 0, vy: 0 }];
      step(g, 1 / 60, idle);
      expect(g.boss).toBeNull();
      if (level < 2) {
        expect(g.phase).toBe("banner");
        run(g, 2.1);
      }
    }
    expect(g.phase).toBe("won");
  });

  it("a bug that reaches the ship costs a life, with a moment's grace after; three and it's over", () => {
    const g = playing();
    g.toSpawn = 0;
    g.enemies = [{ x: g.player.x, y: g.player.y, vy: 0, kind: 0, hp: 1, t: 0, fireIn: 9 }];
    step(g, 1 / 60, idle);
    expect(g.lives).toBe(2);
    g.enemyShots = [{ x: g.player.x, y: g.player.y, vx: 0, vy: 0 }];
    step(g, 1 / 60, idle);
    expect(g.lives).toBe(2);
    for (const lives of [1, 0]) {
      g.player.invuln = 0;
      g.enemyShots = [{ x: g.player.x, y: g.player.y, vx: 0, vy: 0 }];
      step(g, 1 / 60, idle);
      expect(g.lives).toBe(lives);
    }
    expect(g.phase).toBe("over");
    // Bugs that slip past don't cost anything.
    const h = playing();
    h.enemies = [{ x: 10, y: H + 5, vy: 100, kind: 0, hp: 1, t: 0, fireIn: 9 }];
    h.player.x = 200;
    run(h, 0.2);
    expect(h.lives).toBe(3);
  });
});
