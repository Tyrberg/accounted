import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  allowlistChanges,
  buildFullTreeDiff,
  classifySwedishId,
  denylistHits,
  foldText,
  hasGiroContext,
  isBankgiro,
  isCompactOrgNumber,
  isIban,
  isPlusgiro,
  isPrivateIp,
  isRealEmailDomain,
  loadDenylist,
  luhnValid,
  maskValue,
  normalizeRefArg,
  parseAllowlist,
  parseDenylist,
  resolveRefArgs,
  scanAllowlistFile,
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
/** Builds an IBAN with correct mod-97 check digits for the given BBAN. */
function ibanFor(country: string, bban: string): string {
  const digits = (bban + country + "00").replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55)
  );
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return country + String(98 - rem).padStart(2, "0") + bban;
}
const IBAN = ibanFor("SE", "99999999999999999999");
const IBAN_BAD = j(IBAN.slice(0, 2), String((Number(IBAN.slice(2, 4)) + 1) % 100).padStart(2, "0"), IBAN.slice(4));
const IBAN_GROUPED = IBAN.replace(/(.{4})(?!$)/g, "$1 ");
const ORG_COMPACT = ORG.replace("-", "");
const PUBLIC_BODY = withCheck("212000999");
const FICTIONAL_ORG = j("556677", "-", "8899");
// Fictional denylist terms; real ones only ever live in the CI secret.
const DENY_TERM = "Zyxwvu Holding";
const DENY_TERM_ASCII_FOLDED = "zyxwvu holding";

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

  it("requires bankgiro/plusgiro/bg/pg just before the number", () => {
    expect(hasGiroContext(`Bankgiro: ${BG8}`, 9)).toBe(true);
    expect(hasGiroContext(`pg ${PG}`, 3)).toBe(true);
    expect(hasGiroContext(`amount ${BG8}`, 7)).toBe(false);
    expect(hasGiroContext(`bgcolor ${BG8}`, 8)).toBe(false);
  });
});

describe("isCompactOrgNumber", () => {
  it("detects org numbers without hyphen, with or without the 16 prefix", () => {
    expect(isCompactOrgNumber(ORG_COMPACT)).toBe(true);
    expect(isCompactOrgNumber(j("16", ORG_COMPACT))).toBe(true);
    expect(isCompactOrgNumber(ORG_BAD.replace("-", ""))).toBe(false);
  });

  it("skips public bodies (group 2) and personal-ID shaped numbers", () => {
    expect(isCompactOrgNumber(PUBLIC_BODY)).toBe(false);
    expect(classifySwedishId(hyphenate(PUBLIC_BODY, 6))).toBeNull();
    expect(isCompactOrgNumber(PID10.replace("-", ""))).toBe(false);
  });
});

describe("isIban", () => {
  it("accepts the right country length with a valid mod-97 checksum", () => {
    expect(isIban(IBAN)).toBe(true);
    expect(isIban(IBAN_GROUPED)).toBe(true);
    expect(isIban(ibanFor("DE", "999999999999999999"))).toBe(true);
  });

  it("rejects wrong checksums, wrong lengths and unknown countries", () => {
    expect(isIban(IBAN_BAD)).toBe(false);
    expect(isIban(ibanFor("SE", "9".repeat(10)))).toBe(false);
    expect(isIban(ibanFor("QQ", "99999999999999999999"))).toBe(false);
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

  it("does not flag reserved names, fictional or project domains", () => {
    for (const domain of [
      "example.se",
      "exempel.se",
      "test.se",
      "shop.example",
      "mail.test",
      "y.se",
      "gnubok.se",
      "app.accounted.se",
    ]) {
      expect(isRealEmailDomain(j("a", "@", domain))).toBe(false);
    }
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

  it("reports an org number without hyphen", () => {
    expect(kinds(`orgnr ${ORG_COMPACT}`)).toEqual([
      "Swedish org number (valid checksum)",
    ]);
    expect(kinds(`--org-number 16${ORG_COMPACT}`)).toEqual([
      "Swedish org number (valid checksum)",
    ]);
    expect(kinds(`id_${ORG_COMPACT}x 1${ORG_COMPACT} 0.${ORG_COMPACT}`)).toEqual([]);
  });

  it("reports bankgiro and plusgiro", () => {
    expect(kinds(`bg ${BG7}`)).toEqual(["Bankgiro number (valid checksum)"]);
    expect(kinds(`bg ${BG8}`)).toEqual(["Bankgiro number (valid checksum)"]);
    expect(kinds(`bankgiro ${BG8.replace("-", "")}`)).toEqual([
      "Bankgiro number (valid checksum)",
    ]);
    expect(kinds(`pg ${PG}`)).toEqual(["Plusgiro number (valid checksum)"]);
  });

  it("ignores giro-shaped numbers without bankgiro/plusgiro context", () => {
    expect(kinds(`total ${BG8}`)).toEqual([]);
    expect(kinds(j("charset ISO-", "8859-1"))).toEqual([]);
  });

  it("does not report the built-in fictional values", () => {
    expect(kinds(`orgnr ${FICTIONAL_ORG} ${FICTIONAL_ORG.replace("-", "")}`)).toEqual([]);
    expect(kinds(j("iban SE45 5000 0000 ", "0583 9825 7466"))).toEqual([]);
  });

  it("does not report year ranges, dates or digits inside longer numbers", () => {
    expect(kinds(`period ${YEARS}`)).toEqual([]);
    expect(kinds(j("date 2024", "-01-05"))).toEqual([]);
    expect(kinds(j("phone 0", BG7, "123"))).toEqual([]);
  });

  it("reports IBAN (compact or grouped), private IP and real-domain email", () => {
    expect(kinds(`iban ${IBAN}`)).toEqual(["IBAN number (valid checksum)"]);
    expect(kinds(`iban ${IBAN_GROUPED} end`)).toEqual([
      "IBAN number (valid checksum)",
    ]);
    expect(kinds(`iban ${IBAN_BAD}`)).toEqual([]);
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

  it("skips *:value allowlist entries in every file", () => {
    const allow = parseAllowlist(`*:${IP_PRIVATE}\n`);
    expect(
      scanLine(`host ${IP_PRIVATE}`, 1, "other.ts", allow)
    ).toEqual([]);
  });

  it("reports denylisted terms case- and diacritic-insensitively, without the term", () => {
    const deny = parseDenylist(DENY_TERM);
    const findings = scanLine(
      "Faktura till ZYXWVÜ holding AB",
      7,
      "f.ts",
      none,
      deny
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      line: 7,
      match: "denylist entry #1",
      secret: true,
    });
    expect(JSON.stringify(findings)).not.toContain("olding");
  });
});

describe("denylist parsing", () => {
  it("folds case and diacritics", () => {
    expect(foldText("ÅÄÖ Éé")).toBe("aao ee");
  });

  it("ignores comments, blank lines and terms under 3 characters", () => {
    expect(parseDenylist(`# names\n\n${DENY_TERM}\nab\n`)).toEqual([
      DENY_TERM_ASCII_FOLDED,
    ]);
  });

  it("returns the 1-based entries a text contains", () => {
    const deny = parseDenylist(`first term\n${DENY_TERM}`);
    expect(denylistHits(`x ${DENY_TERM} y`, deny)).toEqual([2]);
    expect(denylistHits("nothing here", deny)).toEqual([]);
    expect(denylistHits("anything", [])).toEqual([]);
  });

  it("loads terms from the env secret and from a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "denylist-"));
    const file = path.join(dir, "list");
    fs.writeFileSync(file, "second term\n");
    const loaded = loadDenylist({
      PRIVATE_INFO_DENYLIST: `${DENY_TERM}\n`,
      PRIVATE_INFO_DENYLIST_FILE: file,
    });
    expect(loaded.terms).toEqual([DENY_TERM_ASCII_FOLDED, "second term"]);
    expect(loaded.sources).toEqual(["PRIVATE_INFO_DENYLIST", file]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("maskValue", () => {
  it("keeps only the edges of a value", () => {
    expect(maskValue("abcdefgh")).toBe("ab*****h");
    expect(maskValue("abc")).toBe("***");
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

  it("checks added allowlist lines against the denylist", () => {
    const withTerm = diff.replace(`+x.ts:${IP_TEN}`, `+x.ts:${DENY_TERM}`);
    const findings = scanDiff(withTerm, none, parseDenylist(DENY_TERM));
    expect(findings.map((f) => [f.file, f.line, f.secret])).toContainEqual([
      ".github/private-info-allowlist.txt",
      2,
      true,
    ]);
  });

  it("counts allowlist changes, and returns null when the allowlist is untouched", () => {
    expect(allowlistChanges(diff)).toEqual({ added: 1, removed: 0 });
    expect(allowlistChanges(diff.split("diff --git a/.github")[0])).toBeNull();
  });
});

describe("scanAllowlistFile", () => {
  it("checks every allowlist line against the denylist", () => {
    const content = `# header\nx.ts:${IP_TEN}\ny.ts:${DENY_TERM}\n`;
    expect(
      scanAllowlistFile(content, parseDenylist(DENY_TERM)).map((f) => f.line)
    ).toEqual([3]);
    expect(scanAllowlistFile(content, [])).toEqual([]);
  });
});

describe("buildFullTreeDiff", () => {
  it("adds every text file in full and skips binaries", () => {
    const files: Record<string, Buffer> = {
      "a.txt": Buffer.from(`one\nhost ${IP_PRIVATE}`),
      "b.bin": Buffer.from([0, 1, 2]),
    };
    const diff = buildFullTreeDiff(Object.keys(files), (f) => files[f]);
    expect(diff).not.toContain("b.bin");
    expect(
      scanDiff(diff, none).map((f) => [f.file, f.line, f.match])
    ).toEqual([["a.txt", 2, IP_PRIVATE]]);
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

  it("discards unexpanded shell variables", () => {
    expect(normalizeRefArg("$BASE_SHA")).toBeUndefined();
    expect(resolveRefArgs(["$BASE_SHA", "$HEAD_SHA"])).toEqual({});
    expect(resolveRefArgs(['"$BASE_SHA"', '"$HEAD_SHA"'])).toEqual({});
  });
});

// Each case spawns a process; under a full parallel run the default 5 s is too
// tight, so the block gets an explicit timeout.
describe("CLI", { timeout: 30_000 }, () => {
  const script = path.join(process.cwd(), "scripts/check-private-info.ts");
  // Run node with the tsx loader directly: no npx resolution and no extra
  // child process from the tsx CLI wrapper.
  const tsxLoader = pathToFileURL(
    path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs")
  ).href;

  function run(
    cwd: string,
    args: string[],
    extraEnv: Record<string, string> = {}
  ) {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    // Local behaviour unless a test opts into CI mode.
    if (!("GITHUB_ACTIONS" in extraEnv)) delete env.GITHUB_ACTIONS;
    if (!("PRIVATE_INFO_DENYLIST" in extraEnv)) delete env.PRIVATE_INFO_DENYLIST;
    delete env.PRIVATE_INFO_DENYLIST_FILE;
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--import", tsxLoader, script, ...args],
        { cwd, env, encoding: "utf-8", stdio: "pipe" }
      );
      return { code: 0, out: stdout };
    } catch (error: unknown) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, out: e.stdout + e.stderr };
    }
  }

  function repoWith(added: string, allowlist?: string, message = "change") {
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
    git("commit", "-qm", message);
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

  it("masks values and hides allowlist keys in CI output", () => {
    const { dir, base, head } = repoWith(`host ${IP_PRIVATE}`);
    const result = run(dir, [base, head], { GITHUB_ACTIONS: "true" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("a.txt:2");
    expect(result.out).toContain(maskValue(IP_PRIVATE));
    expect(result.out).not.toContain(IP_PRIVATE);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns in CI when no denylist is configured, but still passes a clean diff", () => {
    const { dir, base, head } = repoWith("nothing private");
    const result = run(dir, [base, head], { GITHUB_ACTIONS: "true" });
    expect(result.code).toBe(0);
    expect(result.out).toContain("::warning::No denylist loaded");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a denylisted term in the diff without printing it", () => {
    const { dir, base, head } = repoWith(`customer ${DENY_TERM}`);
    const result = run(dir, [base, head], {
      GITHUB_ACTIONS: "true",
      PRIVATE_INFO_DENYLIST: DENY_TERM,
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("denylist entry #1");
    expect(result.out.toLowerCase()).not.toContain(DENY_TERM_ASCII_FOLDED);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the local untracked denylist file", () => {
    const { dir, base, head } = repoWith(`customer ${DENY_TERM}`);
    fs.writeFileSync(path.join(dir, ".private-info-denylist"), `${DENY_TERM}\n`);
    const result = run(dir, [base, head]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Denylist: 1 term(s) from .private-info-denylist");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a denylisted term in a commit message", () => {
    const { dir, base, head } = repoWith("clean line", undefined, `fix for ${DENY_TERM}`);
    const result = run(dir, [base, head], { PRIVATE_INFO_DENYLIST: DENY_TERM });
    expect(result.code).toBe(1);
    expect(result.out).toContain(`commit ${head.slice(0, 8)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("flags an allowlist change and fails when the allowlist holds a denylisted term", () => {
    const { dir, base, head } = repoWith("clean line", `a.txt:${DENY_TERM}\n`);
    const result = run(dir, [base, head], {
      GITHUB_ACTIONS: "true",
      PRIVATE_INFO_DENYLIST: DENY_TERM,
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "::warning file=.github/private-info-allowlist.txt::This change edits"
    );
    expect(result.out).toContain(".github/private-info-allowlist.txt:1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("flags an allowlist change even when every check passes", () => {
    const { dir, base, head } = repoWith(
      `host ${IP_PRIVATE}`,
      `a.txt:${IP_PRIVATE}\n`
    );
    const result = run(dir, [base, head]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("This change edits .github/private-info-allowlist.txt (+1/-0 lines)");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
