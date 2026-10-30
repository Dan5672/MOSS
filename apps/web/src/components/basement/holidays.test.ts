import { describe, expect, it } from "vitest";
import { easterSunday, holidayOn } from "./holidays";

const on = (y: number, m: number, d: number) => holidayOn(new Date(y, m - 1, d));

describe("Basement holidays", () => {
  it("knows when Easter falls", () => {
    expect(easterSunday(2026)).toEqual([3, 5]);
    expect(easterSunday(2027)).toEqual([2, 28]);
    expect(easterSunday(2038)).toEqual([3, 25]);
  });

  it("decorates from 5 days before until the day itself", () => {
    expect(on(2026, 12, 19)).toBeNull();
    expect(on(2026, 12, 20)).toBe("christmas");
    expect(on(2026, 12, 25)).toBe("christmas");
    expect(on(2026, 12, 26)).toBeNull();
    expect(on(2026, 10, 30)).toBe("halloween");
    expect(on(2027, 1, 21)).toBe("australia_day");
    expect(on(2027, 2, 9)).toBe("valentines");
    expect(on(2027, 5, 4)).toBe("star_wars");
    expect(on(2026, 4, 1)).toBe("easter");
  });

  it("keeps Oktoberfest up for its whole run", () => {
    // 2026: 19 September to 4 October.
    expect(on(2026, 9, 13)).toBeNull();
    expect(on(2026, 9, 14)).toBe("oktoberfest");
    expect(on(2026, 10, 4)).toBe("oktoberfest");
    expect(on(2026, 10, 5)).toBeNull();
  });

  it("picks the sooner holiday where two overlap", () => {
    // Easter 2285 is 22 March, so its lead-in starts on St Patrick's Day, which wins that day.
    expect(easterSunday(2285)).toEqual([2, 22]);
    expect(on(2285, 3, 17)).toBe("st_patricks");
    expect(on(2285, 3, 18)).toBe("easter");
  });
});
