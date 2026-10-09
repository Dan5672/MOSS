import { describe, expect, it } from "vitest";
import { secretValueProblem } from "./secret-value";

describe("secret value checks", () => {
  it("accepts ordinary passwords, keys and community strings, including ones with a space or two", () => {
    expect(secretValueProblem("c0rrect-Horse!battery", "password")).toBeNull();
    expect(secretValueProblem("correct horse battery", "password")).toBeNull();
    expect(secretValueProblem("eyJhbGciOiJIUzI1NiJ9.e30.abc", "api_token")).toBeNull();
    expect(secretValueProblem("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n", "ssh_key")).toBeNull();
  });

  it("flags spaces around it, more than one line, and pasted notes", () => {
    expect(secretValueProblem(" hunter2", "password")).toMatch(/starts or ends/);
    expect(secretValueProblem("hunter2\n", "api_token")).toMatch(/starts or ends/);
    expect(secretValueProblem("line1\nline2", "password")).toMatch(/more than one line/);
    expect(secretValueProblem("Username: sysadmin. Password: hunter2 for the gateway.", "password")).toMatch(/sentence or a note/);
  });
});
