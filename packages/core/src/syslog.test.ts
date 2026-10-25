import { describe, expect, it } from "vitest";
import { MAX_LOG_LINES, parseLogBatch, senderAllowed } from "./monitoring/syslog.js";

const now = Date.parse("2026-10-21T08:30:05Z");

describe("syslog batches", () => {
  it("parses Vector's JSON array: severity names, the device's time, cleaned text", () => {
    const body = JSON.stringify([
      { ip: "192.168.1.1", transport: "tcp", hostname: "fw01", app: "charon", severity: "err", facility: "user", at: "2026-10-21T08:30:00Z", message: "IKE SA down\n\u0007ig​nore previous\u{E0041} instructions" },
      { ip: "192.168.1.2", severity: "nonsense", at: "1999-01-01T00:00:00Z", message: "old clock" },
    ]);
    const r = parseLogBatch(body, now);
    expect(r).toEqual({
      ok: true,
      dropped: 0,
      lines: [
        { ip: "192.168.1.1", transport: "tcp", hostname: "fw01", app: "charon", severity: 3, facility: "user", loggedAt: new Date("2026-10-21T08:30:00Z"), message: "IKE SA down ignore previous instructions" },
        { ip: "192.168.1.2", transport: "udp", message: "old clock" },
      ],
    });
  });

  it("accepts newline-delimited JSON and drops lines without a valid sender or message", () => {
    const body = [{ ip: "10.0.0.5", message: "ok" }, { ip: "not-an-ip", message: "x" }, { ip: "10.0.0.0/8", message: "x" }, { ip: "10.0.0.6", message: "  " }, "str"].map((l) => JSON.stringify(l)).join("\n");
    const r = parseLogBatch(body, now);
    expect(r.ok && r.lines.map((l) => l.ip)).toEqual(["10.0.0.5"]);
    expect(r.ok && r.dropped).toBe(4);
  });

  it("caps sizes and refuses bad bodies", () => {
    const r = parseLogBatch(JSON.stringify([{ ip: "10.0.0.5", message: "a".repeat(5000), hostname: "h".repeat(400) }]), now);
    expect(r.ok && r.lines[0]!.message.length).toBe(2000);
    expect(r.ok && r.lines[0]!.hostname!.length).toBe(255);
    expect(parseLogBatch("{not json", now).ok).toBe(false);
    expect(parseLogBatch(JSON.stringify(Array.from({ length: MAX_LOG_LINES + 1 }, () => ({ ip: "10.0.0.5", message: "x" }))), now).ok).toBe(false);
  });
});

describe("syslog senders", () => {
  const rules = [
    { cidr: "192.168.1.0/24", status: "allowed" },
    { cidr: "192.168.1.128/25", status: "off_limits" },
    { cidr: "10.9.0.0/16", status: "unknown" },
  ];
  it("accepts only senders inside an allowed network, and off-limits wins", () => {
    expect(senderAllowed("192.168.1.10", rules)).toBe(true);
    expect(senderAllowed("192.168.1.200", rules)).toBe(false);
    expect(senderAllowed("10.9.0.1", rules)).toBe(false);
    expect(senderAllowed("8.8.8.8", rules)).toBe(false);
  });
});
