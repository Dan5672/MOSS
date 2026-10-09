import { describe, expect, it } from "vitest";
import { parseMentions, type Mentionable } from "./services/mentions.js";

const people: Mentionable[] = [
  { type: "agent", id: "a1", name: "Nina" },
  { type: "agent", id: "a2", name: "Rambo" },
  { type: "user", id: "u1", name: "Vic" },
  { type: "user", id: "u2", name: "Vic Viewer" },
];

describe("@mentions", () => {
  it("finds agents and people by name, longest name first, each once", () => {
    expect(parseMentions("@nina can you check? cc @Vic Viewer and @Rambo, @Nina again", people)).toEqual([
      { type: "agent", id: "a1" },
      { type: "user", id: "u2" },
      { type: "agent", id: "a2" },
    ]);
  });

  it("ignores email addresses, unknown names and partial words", () => {
    expect(parseMentions("mail vic@home.test, ask @Nobody, or @Ninakins", people)).toEqual([]);
    expect(parseMentions("@Vic: thanks", people)).toEqual([{ type: "user", id: "u1" }]);
  });
});
