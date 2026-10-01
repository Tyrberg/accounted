import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  classifySwedishId,
  isBankgiro,
  isPlusgiro,
  isPrivateIp,
  isRealEmailDomain,
  luhnValid,
  normalizeRefArg,
  parseAllowlist,
  resolveRefArgs,
  scanDiff,
  scanLine,
} from "../check-private-info";

// The gate scans this file's own diff, so every value shaped like private data
// is assembled at runtime and never appears literally in the source.
const j = (...parts: string[]) => parts.join("");

/** Appends the Luhn check digit to a digit string. */
function withCheck(prefix: string): string {
  for (let d = 0; d <= 9; d++) {
    if (luhnValid(prefix + d)) return prefix + d;
  }
  throw new Error("unreachable");
}
/** Appends a digit that makes the Luhn check fail. */
function withBadCheck(prefix: string): string {
  const good = Number(withCheck(prefix).slice(-1));
  return prefix + ((good + 1) % 10);
}
const hyphenate = (digits: string, at: number) =>
  j(digits.slice(0, at), "-", digits.slice(at));

const ORG = hyphenate(withCheck("999920000"), 6);
const ORG_BAD = hyphenate(withBadCheck("999920000"), 6);
const PID10 = hyphenate(withCheck("990101999"), 6);
const PID10_BAD = hyphenate(withBadCheck("990101999"), 6);
const PID12 = j("19", PID10);
const PID12_BAD = j("19", PID10_BAD);
const BG7 = hyphenate(withCheck("999000"), 3);
const BG8 = hyphenate(withCheck("9990000"), 4);
const BG_BAD = hyphenate(withBadCheck("9990000"), 4);
const PG = hyphenate(withCheck("999000"), 6);
const PG_BAD = hyphenate(withBadCheck("999000"), 6);
const YEARS = j("20", "23", "-", "20", "24");
const IP_PRIVATE = ["192", "168", "1", "1"].join(".");
const IP_TEN = ["10", "0", "0", "1"].join(".");
const IP_LOOPBACK = ["127", "0", "0", "1"].join(".");
const EMAIL_REAL = j("user", "@", "gmail.com");
const EMAIL_EXAMPLE = j("user", "@", "example.com");
const IBAN = j("S", "E", "0099999999999999999999");

const none = new Set<string>();
const kinds = (content: string, allow = none) =>
  scanLine(content, 1, "f.ts", allow).map((f) => f.pattern);

describe("luhnValid", () => {
  it("accepts computed check digits and rejects wrong ones", () => {
    expect(luhnValid(withCheck("123456789"))).toBe(true);
    expect(luhnValid(withBadCheck("123456789"))).toBe(false);
    expect(luhnValid("12a")).toBe(false);
  });
});

describe("classifySwedishId", () => {
  it("classifies a valid org number", () => {
    expect(classifySwedishId(ORG)).toBe("org-number");
    expect(classifySwedishId(ORG_BAD)).toBeNull();
  });

  it("classifies a valid 10-digit personal ID, with - or +", () => {
    expect(classifySwedishId(PID10)).toBe("personal-id");
    expect(classifySwedishId(PID10.replace("-", "+"))).toBe("personal-id");
    expect(classifySwedishId(PID10_BAD)).toBeNull();
  });

  it("classifies a valid 12-digit personal ID (YYYYMMDD-NNNN)", () => {
    expect(classifySwedishId(PID12)).toBe("personal-id");
    expect(classifySwedishId(PID12_BAD)).toBeNull();
  });

  it("rejects personal IDs with impossible dates", () => {
    const badMonth = hyphenate(withCheck("991301999"), 6);
    expect(classifySwedishId(badMonth)).toBeNull();
  });

  it("accepts samordningsnummer (day + 60)", () => {
    const coord = hyphenate(withCheck("990161999"), 6);
    expect(classifySwedishId(coord)).toBe("personal-id");
  });
});

describe("isBankgiro / isPlusgiro", () => {
  it("detects 7- and 8-digit bankgiro with valid checksum", () => {
    expect(isBankgiro(BG7)).toBe(true);
    expect(isBankgiro(BG8)).toBe(true);
    expect(isBankgiro(BG_BAD)).toBe(false);
  });

  it("never treats year ranges as bankgiro", () => {
    expect(isBankgiro(YEARS)).toBe(false);
  });

  it("does not flag the documented fictional example 999-9999", () => {
    expect(isBankgiro(j("999", "-", "9999"))).toBe(false);
  });

  it("detects plusgiro with valid checksum", () => {
    expect(isPlusgiro(PG)).toBe(true);
    expect(isPlusgiro(PG_BAD)).toBe(false);
  });
});

describe("isPrivateIp / isRealEmailDomain", () => {
  it("flags private ranges but not loopback or public addresses", () => {
    expect(isPrivateIp(IP_PRIVATE)).toBe(true);
    expect(isPrivateIp(IP_TEN)).toBe(true);
    expect(isPrivateIp(["172", "20", "0", "1"].join("."))).toBe(true);
    expect(isPrivateIp(IP_LOOPBACK)).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("flags real domains but not example.com", () => {
    expect(isRealEmailDomain(EMAIL_REAL)).toBe(true);
    expect(isRealEmailDomain(EMAIL_EXAMPLE)).toBe(false);
  });
});

describe("scanLine", () => {
  it("reports a valid org number once, as an org number", () => {
    expect(kinds(`id ${ORG}`)).toEqual(["Swedish org number (valid checksum)"]);
  });

  it("reports 10- and 12-digit personal IDs once, as personal IDs", () => {
    expect(kinds(`pnr ${PID10}`)).toEqual([
      "Swedish personal ID (valid checksum)",
    ]);
    expect(kinds(`pnr ${PID12}`)).toEqual([
      "Swedish personal ID (valid checksum)",
    ]);
  });

  it("ignores IDs with invalid checksum", () => {
    expect(kinds(`${ORG_BAD} ${PID10_BAD} ${PID12_BAD}`)).toEqual([]);
  });

  it("reports bankgiro and plusgiro", () => {
    expect(kinds(`bg ${BG7}`)).toEqual(["Bankgiro number (valid checksum)"]);
    expect(kinds(`bg ${BG8}`)).toEqual(["Bankgiro number (valid checksum)"]);
    expect(kinds(`pg ${PG}`)).toEqual(["Plusgiro number (valid checksum)"]);
  });

  it("does not report year ranges, dates or digits inside longer numbers", () => {
    expect(kinds(`period ${YEARS}`)).toEqual([]);
    expect(kinds(j("date 2024", "-01-05"))).toEqual([]);
    expect(kinds(j("phone 0", BG7, "123"))).toEqual([]);
  });

  it("reports IBAN, private IP and real-domain email", () => {
    expect(kinds(`iban ${IBAN}`)).toEqual(["IBAN number"]);
    expect(kinds(`host ${IP_PRIVATE}`)).toEqual(["Private IP address"]);
    expect(kinds(`mail ${EMAIL_REAL}`)).toEqual(["Email to real domain"]);
  });

  it("ignores loopback, public IPs and example.com", () => {
    expect(kinds(`${IP_LOOPBACK} 8.8.8.8 ${EMAIL_EXAMPLE}`)).toEqual([]);
  });

  it("skips allowlisted file:value pairs only for that file", () => {
    const allow = parseAllowlist(`# comment\n\nf.ts:${IP_PRIVATE}\n`);
    expect(kinds(`host ${IP_PRIVATE}`, allow)).toEqual([]);
    expect(
      scanLine(`host ${IP_PRIVATE}`, 1, "other.ts", allow).map((f) => f.match)
    ).toEqual([IP_PRIVATE]);
  });
});

describe("scanDiff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3,0 +4,2 @@",
    "+safe line",
    `+host ${IP_PRIVATE}`,
    "@@ -10 +12 @@",
    `-old ${IP_TEN}`,
    `+new ${EMAIL_REAL}`,
    "diff --git a/docs/b.md b/docs/b.md",
    "--- a/docs/b.md",
    "+++ b/docs/b.md",
    "@@ -1 +1,0 @@",
    `-${ORG}`,
    "diff --git a/.github/private-info-allowlist.txt b/.github/private-info-allowlist.txt",
    "--- a/.github/private-info-allowlist.txt",
    "+++ b/.github/private-info-allowlist.txt",
    "@@ -1,0 +2 @@",
    `+x.ts:${IP_TEN}`,
  ].join("\n");

  it("reports only added lines outside the allowlist file, with correct file and line numbers", () => {
    const findings = scanDiff(diff, none);
    expect(findings.map((f) => [f.file, f.line, f.match])).toEqual([
      ["src/a.ts", 5, IP_PRIVATE],
      ["src/a.ts", 12, EMAIL_REAL],
    ]);
  });
});

describe("normalizeRefArg", () => {
  it("treats empty and unexpanded CI expressions as missing", () => {
    expect(normalizeRefArg(undefined)).toBeUndefined();
    expect(normalizeRefArg("")).toBeUndefined();
    expect(normalizeRefArg(j("$", "{{ github.event.pull_request.base.sha }}")))
      .toBeUndefined();
    expect(normalizeRefArg("abc123")).toBe("abc123");
  });
});

// An unexpanded expression split on whitespace into separate arguments.
const SPLIT_EXPR = [
  j("$", "{{"),
  "github.event.pull_request.base.sha",
  "}}",
  j("$", "{{"),
  "github.event.pull_request.head.sha",
  "}}",
];

describe("resolveRefArgs", () => {
  it("passes real refs through", () => {
    expect(resolveRefArgs(["abc", "def"])).toEqual({ base: "abc", head: "def" });
    expect(resolveRefArgs([])).toEqual({ base: undefined, head: undefined });
  });

  it("discards all arguments when an expression is split across them", () => {
    expect(resolveRefArgs(SPLIT_EXPR)).toEqual({});
    expect(resolveRefArgs(["abc", "}}"])).toEqual({});
  });
});

describe("CLI", () => {
  const script = path.join(process.cwd(), "scripts/check-private-info.ts");

  function run(cwd: string, args: string[]) {
    try {
      const stdout = execFileSync("npx", ["tsx", script, ...args], {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return { code: 0, out: stdout };
    } catch (error: unknown) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: e.stdout + e.stderr };
    }
  }

  function repoWith(added: string, allowlist?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-info-"));
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: dir, encoding: "utf-8" }).trim();
    git("init", "-q", "-b", "feature");
    git("config", "user.email", EMAIL_EXAMPLE);
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "a.txt"), `base\n${added}\n`);
    if (allowlist !== undefined) {
      fs.mkdirSync(path.join(dir, ".github"));
      fs.writeFileSync(
        path.join(dir, ".github/private-info-allowlist.txt"),
        allowlist
      );
    }
    git("add", ".");
    git("commit", "-qm", "change");
    return { dir, base, head: git("rev-parse", "HEAD") };
  }

  it("exits 1 with file, line and allowlist hint on a finding", () => {
    const { dir, base, head } = repoWith(`host ${IP_PRIVATE}`);
    const result = run(dir, [base, head]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("a.txt:2");
    expect(result.out).toContain(`a.txt:${IP_PRIVATE}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 when the finding is allowlisted", () => {
    const { dir, base, head } = repoWith(
      `host ${IP_PRIVATE}`,
      `a.txt:${IP_PRIVATE}\n`
    );
    expect(run(dir, [base, head]).code).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to merge-base with main when CI expressions are unexpanded", () => {
    const { dir, base } = repoWith(`host ${IP_PRIVATE}`);
    execFileSync("git", ["branch", "main", base], { cwd: dir });
    const expr = j("$", "{{ github.event.pull_request.base.sha }}");
    const result = run(dir, [expr, expr]);
    expect(result.code).toBe(1);
    expect(result.out).toContain(IP_PRIVATE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to merge-base with main when an expression is split across arguments", () => {
    const { dir, base } = repoWith(`host ${IP_PRIVATE}`);
    execFileSync("git", ["branch", "main", base], { cwd: dir });
    const result = run(dir, SPLIT_EXPR);
    expect(result.code).toBe(1);
    expect(result.out).toContain(IP_PRIVATE);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
