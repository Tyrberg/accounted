#!/usr/bin/env npx tsx

/**
 * Scans git diff for private information patterns.
 *
 * Generic patterns (always on):
 * - Swedish org numbers (with or without hyphen) and personal IDs, valid
 *   Luhn checksum only
 * - bankgiro and plusgiro numbers with a valid checksum, only when the words
 *   bankgiro/plusgiro/bg/pg appear just before the number
 * - IBAN numbers with the right length for their country and a valid mod-97
 * - private IPv4 ranges
 * - email addresses to real domains (anything but reserved example/test names)
 *
 * Denylist (names, companies, hostnames): never stored in this repository.
 * Read from the PRIVATE_INFO_DENYLIST environment variable (a CI secret, one
 * term per line), from the file named by PRIVATE_INFO_DENYLIST_FILE, and from
 * the untracked file .private-info-denylist at the repo root. Matches are
 * case- and diacritic-insensitive, and the matched term is never printed. In CI
 * a missing denylist is a warning, not a silent pass. The denylist is also
 * checked against the whole allowlist file and the PR's commit messages.
 *
 * A diff that changes the allowlist is flagged in the output for review.
 *
 * Usage:
 *   check-private-info.ts [<base-sha>] [<head-sha>]
 *   check-private-info.ts --all      Scan every tracked file as if new
 *
 * If base-sha is omitted, the merge-base with origin/main (or main) is used.
 * If head-sha is omitted, the working tree is compared against base-sha.
 * If any argument holds an unexpanded CI expression (a literal "${{" or "}}",
 * whole or split across arguments), all arguments count as omitted.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import { fileURLToPath } from "url";

export interface Finding {
  file: string;
  line: number;
  pattern: string;
  match: string;
  context: string;
  /** Set for denylist hits: the value must never be printed. */
  secret?: boolean;
}

export const ALLOWLIST_FILE = ".github/private-info-allowlist.txt";
export const LOCAL_DENYLIST_FILE = ".private-info-denylist";
const DENYLIST_PATTERN = "Denylisted name, company or host";

/**
 * Known fictional test values allowed in every file, compared after removing
 * spaces and hyphens. Only clearly made-up sequences and published registry
 * examples belong here, never a value taken from real data.
 */
export const DEFAULT_ALLOWED_VALUES = new Set([
  "5566778899", // the documented fictional org number
  "SE4550000000058398257466", // IBAN registry example for Sweden
  "SE3550000000054910000003", // IBAN registry example for Sweden
  "DE89370400440532013000", // IBAN registry example for Germany
  "GB82WEST12345698765432", // IBAN registry example for the UK
  "50501055", // the tax agency's published bankgiro, printed on every tax form
  "169.254.169.254", // the cloud metadata endpoint SSRF guards block
]);

/** The project's own public domains (README), never private. */
const PROJECT_EMAIL_DOMAINS = ["gnubok.se", "accounted.se"];

export function parseAllowlist(content: string): Set<string> {
  return new Set(
    content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  );
}

function loadAllowlist(): Set<string> {
  if (!fs.existsSync(ALLOWLIST_FILE)) {
    return new Set();
  }
  return parseAllowlist(fs.readFileSync(ALLOWLIST_FILE, "utf-8"));
}

export function generateAllowlistKey(file: string, match: string): string {
  return `${file}:${match}`;
}

/** Removes spaces and hyphens, and the "16" prefix of a 12-digit org number. */
const compact = (value: string) => {
  const v = value.replace(/[\s-]/g, "");
  return /^16\d{10}$/.test(v) ? v.slice(2) : v;
};

export function isAllowed(
  file: string,
  match: string,
  allowlist: Set<string>
): boolean {
  if (DEFAULT_ALLOWED_VALUES.has(compact(match))) return true;
  return (
    allowlist.has(generateAllowlistKey(file, match)) ||
    allowlist.has(generateAllowlistKey("*", match))
  );
}

/** Luhn (mod 10) check over a digit string, the last digit being the check digit. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Classifies NNNNNN-NNNN, NNNNNN+NNNN or YYYYMMDD-NNNN as an org number or a
 * personal ID when the checksum is valid; returns null otherwise. A 10-digit
 * value is an org number when its third digit is 2 or higher (org numbers have
 * a "month" of 20 or more), otherwise a personal ID with a valid date.
 */
export function classifySwedishId(
  value: string
): "org-number" | "personal-id" | null {
  const m = value.match(/^(\d{2})?(\d{6})[-+](\d{4})$/);
  if (!m) return null;
  const [, century, datePart, serial] = m;
  const ten = datePart + serial;
  if (!luhnValid(ten)) return null;

  const month = Number(ten.slice(2, 4));
  const day = Number(ten.slice(4, 6));
  if (!century && month >= 20) {
    return isPublicBody(ten) ? null : "org-number";
  }

  if (century && century !== "19" && century !== "20") return null;
  // Samordningsnummer add 60 to the day.
  const realDay = day > 60 ? day - 60 : day;
  if (month < 1 || month > 12 || realDay < 1 || realDay > 31) return null;
  return "personal-id";
}

/**
 * Group 2 org numbers belong to the state, regions and municipalities: public
 * bodies whose numbers are printed on every form, not private data.
 */
const isPublicBody = (ten: string) => ten.startsWith("2");

/**
 * An org number written without hyphen: 10 digits (optionally prefixed "16"),
 * leading group digit 3-9 (group 2 is public bodies), third digit 2 or
 * higher, valid Luhn checksum.
 */
export function isCompactOrgNumber(value: string): boolean {
  const ten = /^16\d{10}$/.test(value) ? value.slice(2) : value;
  if (!/^[3-9]\d{9}$/.test(ten)) return false;
  if (Number(ten[2]) < 2) return false;
  return luhnValid(ten);
}

/** Bankgiro: NNN-NNNN or NNNN-NNNN (hyphen optional) with a valid Luhn check digit. */
export function isBankgiro(value: string): boolean {
  if (!/^\d{3,4}-?\d{4}$/.test(value)) return false;
  // Year ranges like 2023-2024 have the same shape; never treat them as bankgiro.
  if (/^(19|20)\d{2}-(19|20)\d{2}$/.test(value)) return false;
  return luhnValid(value.replace("-", ""));
}

/** Plusgiro: 1 to 7 digits, hyphen, check digit, with a valid Luhn checksum. */
export function isPlusgiro(value: string): boolean {
  if (!/^\d{1,7}-\d$/.test(value)) return false;
  return luhnValid(value.replace("-", ""));
}

const GIRO_CONTEXT = /\b(?:bank\s?giro\w*|plus\s?giro\w*|bg|pg)\b[^\n]{0,20}$/i;

/** True when bankgiro/plusgiro/bg/pg appears within 20 characters before index. */
export function hasGiroContext(line: string, index: number): boolean {
  return GIRO_CONTEXT.test(line.slice(Math.max(0, index - 40), index));
}

/** IBAN length per country (ISO 13616 registry), EU/EEA and neighbours. */
export const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18,
  EE: 20, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GI: 23, GL: 18, GR: 27,
  HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21,
  MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19,
  SK: 24, SM: 27,
};

/** IBAN with the registered length for its country and a valid mod-97 checksum. */
export function isIban(value: string): boolean {
  const iban = value.replace(/\s/g, "").toUpperCase();
  const length = IBAN_LENGTHS[iban.slice(0, 2)];
  if (!length || iban.length !== length) return false;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export function isPrivateIp(ip: string): boolean {
  // Private IPv4 ranges (RFC 1918: 10/8, 172.16/12, 192.168/16) plus
  // link-local 169.254/16. Loopback is not flagged: it reveals nothing and is
  // the documented fictional example.
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  if (parts.some((p) => p < 0 || p > 255)) return false;

  if (parts[0] === 10) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

export function isRealEmailDomain(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  // The reserved RFC 2606/6761 names, and example./exempel./test. under any TLD.
  if (/\.(example|test|invalid|localhost|local)$/.test(domain)) return false;
  if (/(^|\.)(example|exempel|test)\.[a-z]+$/.test(domain)) return false;
  // One-letter domains (x@y.se) are fictional, not real mailboxes.
  if (/^[a-z]\.[a-z]+$/.test(domain)) return false;
  return !PROJECT_EMAIL_DOMAINS.some(
    (d) => domain === d || domain.endsWith(`.${d}`)
  );
}

interface Detector {
  regex: RegExp;
  label: (value: string, line: string, index: number) => string | null;
}

// Digit-run detectors use (?<![\w-]) / (?![\w-]) so a match never starts or
// ends inside a longer number, date, ID or identifier.
const DETECTORS: Detector[] = [
  {
    regex: /(?<![\w-])(?:\d{2})?\d{6}[-+]\d{4}(?![\w-])/g,
    label: (v) => {
      const kind = classifySwedishId(v);
      if (kind === "org-number") return "Swedish org number (valid checksum)";
      if (kind === "personal-id") return "Swedish personal ID (valid checksum)";
      return null;
    },
  },
  {
    regex: /(?<![\w.,-])(?:16)?\d{10}(?![\w-]|[.,]\d)/g,
    label: (v) =>
      isCompactOrgNumber(v) ? "Swedish org number (valid checksum)" : null,
  },
  {
    regex: /(?<![\w-])\d{3,4}-?\d{4}(?![\w-])/g,
    label: (v, line, i) =>
      isBankgiro(v) && hasGiroContext(line, i)
        ? "Bankgiro number (valid checksum)"
        : null,
  },
  {
    regex: /(?<![\w-])\d{1,7}-\d(?![\w-])/g,
    label: (v, line, i) =>
      isPlusgiro(v) && hasGiroContext(line, i)
        ? "Plusgiro number (valid checksum)"
        : null,
  },
  {
    // Compact or grouped in fours; isIban checks the exact country length.
    regex: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{1,4}){3,8})\b/g,
    label: (v) => (isIban(v) ? "IBAN number (valid checksum)" : null),
  },
  {
    regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    label: (v) => (isPrivateIp(v) ? "Private IP address" : null),
  },
  {
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    label: (v) => (isRealEmailDomain(v) ? "Email to real domain" : null),
  },
];

/** Lowercase and strip diacritics, so "Ö" matches "o" in either direction. */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Parses denylist content: one term per line, # comments, terms under 3 chars ignored. */
export function parseDenylist(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(foldText)
    .filter((term) => term.length >= 3);
}

/** Returns the 1-based denylist entries the text contains. */
export function denylistHits(text: string, denylist: string[]): number[] {
  if (denylist.length === 0) return [];
  const folded = foldText(text);
  const hits: number[] = [];
  denylist.forEach((term, i) => {
    if (folded.includes(term)) hits.push(i + 1);
  });
  return hits;
}

function denylistFindings(
  content: string,
  lineNum: number,
  file: string,
  denylist: string[]
): Finding[] {
  return denylistHits(content, denylist).map((entry) => ({
    file,
    line: lineNum,
    pattern: DENYLIST_PATTERN,
    match: `denylist entry #${entry}`,
    context: "",
    secret: true,
  }));
}

export function scanLine(
  content: string,
  lineNum: number,
  file: string,
  allowlist: Set<string>,
  denylist: string[] = []
): Finding[] {
  const findings: Finding[] = [];
  for (const { regex, label } of DETECTORS) {
    for (const match of content.matchAll(regex)) {
      const index = match.index ?? 0;
      const pattern = label(match[0], content, index);
      if (!pattern) continue;
      if (isAllowed(file, match[0], allowlist)) continue;
      findings.push({
        file,
        line: lineNum,
        pattern,
        match: match[0],
        context: content.substring(
          Math.max(0, index - 20),
          Math.min(content.length, index + match[0].length + 20)
        ),
      });
    }
  }
  findings.push(...denylistFindings(content, lineNum, file, denylist));
  return findings;
}

/** Scans the added lines of a unified diff. */
export function scanDiff(
  diffOutput: string,
  allowlist: Set<string>,
  denylist: string[] = []
): Finding[] {
  const findings: Finding[] = [];
  let currentFile = "";
  let currentLineNum = 0;

  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("diff --git")) {
      // Extract filename from: diff --git a/path b/path
      const match = line.match(/ b\/(.*)$/);
      currentFile = match ? match[1] : "";
    } else if (line.startsWith("@@")) {
      // Parse line number: @@ -start,count +start,count @@
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentLineNum = match ? parseInt(match[1], 10) - 1 : 0;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLineNum++;
      const content = line.substring(1);
      if (currentFile === ALLOWLIST_FILE) {
        // Allowlist entries repeat the values they approve, so only the
        // denylist applies to them.
        findings.push(
          ...denylistFindings(content, currentLineNum, currentFile, denylist)
        );
        continue;
      }
      findings.push(
        ...scanLine(content, currentLineNum, currentFile, allowlist, denylist)
      );
    } else if (line.startsWith(" ")) {
      currentLineNum++;
    }
  }
  return findings;
}

/** Scans the whole allowlist file (not only its diff) against the denylist. */
export function scanAllowlistFile(
  content: string,
  denylist: string[]
): Finding[] {
  return content
    .split("\n")
    .flatMap((line, i) =>
      denylistFindings(line, i + 1, ALLOWLIST_FILE, denylist)
    );
}

/** Counts lines the diff adds to and removes from the allowlist file. */
export function allowlistChanges(diffOutput: string): {
  added: number;
  removed: number;
} | null {
  let inAllowlist = false;
  let touched = false;
  let added = 0;
  let removed = 0;
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("diff --git")) {
      inAllowlist = line.endsWith(` b/${ALLOWLIST_FILE}`);
      touched ||= inAllowlist;
    } else if (inAllowlist && line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (inAllowlist && line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }
  return touched ? { added, removed } : null;
}

/** Builds a diff that adds every given file in full, for whole-tree scans. */
export function buildFullTreeDiff(
  files: string[],
  read: (file: string) => Buffer
): string {
  const parts: string[] = [];
  for (const file of files) {
    const buf = read(file);
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString("utf-8").split("\n");
    parts.push(
      `diff --git a/${file} b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`)
    );
  }
  return parts.join("\n");
}

/** Loads the denylist from the CI secret, an explicit file and the local untracked file. */
export function loadDenylist(
  env: Record<string, string | undefined> = process.env
): {
  terms: string[];
  sources: string[];
} {
  const terms: string[] = [];
  const sources: string[] = [];
  if (env.PRIVATE_INFO_DENYLIST?.trim()) {
    terms.push(...parseDenylist(env.PRIVATE_INFO_DENYLIST));
    sources.push("PRIVATE_INFO_DENYLIST");
  }
  for (const file of [env.PRIVATE_INFO_DENYLIST_FILE, LOCAL_DENYLIST_FILE]) {
    if (file && fs.existsSync(file)) {
      terms.push(...parseDenylist(fs.readFileSync(file, "utf-8")));
      sources.push(file);
    }
  }
  return { terms: [...new Set(terms)], sources };
}

/**
 * True for a CI expression (`${{ ... }}`) or a shell variable (`$BASE_SHA`)
 * that reached the script unexpanded, e.g. through a quoted script line.
 */
const isUnexpanded = (arg: string) =>
  arg.includes("${{") || arg.includes("}}") || /^["']?\$/.test(arg.trim());

/** Treats empty values and unexpanded CI expressions or variables as missing. */
export function normalizeRefArg(arg: string | undefined): string | undefined {
  if (!arg || !arg.trim() || isUnexpanded(arg)) return undefined;
  return arg.trim();
}

/**
 * Resolves base and head refs from CLI arguments. An unexpanded CI expression
 * may arrive split across several arguments, so its fragments would otherwise
 * be read as refs; any sign of one discards all arguments.
 */
export function resolveRefArgs(args: string[]): {
  base?: string;
  head?: string;
} {
  if (args.some(isUnexpanded)) return {};
  return { base: normalizeRefArg(args[0]), head: normalizeRefArg(args[1]) };
}

/** Hides most of a value so CI logs of a public repo never repeat it. */
export function maskValue(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(value.length - 3)}${value.slice(-1)}`;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function defaultBase(): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", ref]).trim();
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("no base given and neither origin/main nor main exists");
}

/** Commit messages in base..head, scanned against the denylist only. */
function commitMessageFindings(
  base: string,
  head: string,
  denylist: string[]
): Finding[] {
  if (denylist.length === 0) return [];
  const log = git(["log", "--format=%H%x00%B%x01", `${base}..${head}`]);
  return log
    .split("\x01")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [sha, message = ""] = entry.split("\x00");
      return denylistFindings(message, 0, `commit ${sha.slice(0, 8)}`, denylist);
    });
}

function main() {
  const argv = process.argv.slice(2);
  const inCi = process.env.GITHUB_ACTIONS === "true";
  const reveal = !inCi;
  const denylist = loadDenylist();

  if (denylist.terms.length === 0) {
    const message =
      "No denylist loaded (PRIVATE_INFO_DENYLIST secret or " +
      `${LOCAL_DENYLIST_FILE}): only generic patterns were checked, ` +
      "real names, companies and hostnames were NOT.";
    console.log(inCi ? `::warning::${message}` : `⚠️  ${message}`);
  } else {
    console.log(
      `Denylist: ${denylist.terms.length} term(s) from ${denylist.sources.join(", ")}`
    );
  }

  let diffOutput: string;
  let commitFindings: Finding[] = [];
  try {
    if (argv[0] === "--all") {
      const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
      diffOutput = buildFullTreeDiff(
        files.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile()),
        (f) => fs.readFileSync(f)
      );
    } else {
      const refs = resolveRefArgs(argv);
      if (argv.length > 0 && !refs.base && !refs.head) {
        console.log(
          "Ref arguments were empty or unexpanded variables; diffing against the merge-base with main."
        );
      }
      const baseSha = refs.base ?? defaultBase();
      const headSha = refs.head;
      const range = headSha ? [`${baseSha}...${headSha}`] : [baseSha];
      diffOutput = git(["diff", ...range, "--unified=0", "--no-color"]);
      if (headSha) {
        commitFindings = commitMessageFindings(baseSha, headSha, denylist.terms);
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get git diff: ${message}`);
    process.exit(4);
  }

  const changes = allowlistChanges(diffOutput);
  if (changes) {
    const message =
      `This change edits ${ALLOWLIST_FILE} (+${changes.added}/-${changes.removed} lines): ` +
      "a reviewer must confirm every new entry is a false positive, not real data.";
    console.log(inCi ? `::warning file=${ALLOWLIST_FILE}::${message}` : `⚠️  ${message}`);
  }

  const allowlistContent = fs.existsSync(ALLOWLIST_FILE)
    ? fs.readFileSync(ALLOWLIST_FILE, "utf-8")
    : "";
  const findings = [
    ...scanDiff(diffOutput, loadAllowlist(), denylist.terms),
    ...scanAllowlistFile(allowlistContent, denylist.terms),
    ...commitFindings,
  ];
  // Added allowlist lines are reported both from the diff and the whole file.
  const unique = [
    ...new Map(
      findings.map((f) => [`${f.file}:${f.line}:${f.pattern}:${f.match}`, f])
    ).values(),
  ];

  if (unique.length > 0) {
    console.error(`❌ Private information found (${unique.length}):\n`);
    unique.forEach((f) => {
      console.error(f.line > 0 ? `  ${f.file}:${f.line}` : `  ${f.file}`);
      console.error(`    Pattern: ${f.pattern}`);
      if (f.secret) {
        console.error(`    Found: ${f.match} (term not printed)`);
      } else {
        console.error(`    Found: ${reveal ? f.match : maskValue(f.match)}`);
        if (reveal) console.error(`    Context: ...${f.context}...`);
      }
      console.error("");
    });
    console.error(
      "Replace real data with fictional values (Example AB, 556677-8899, example.com)."
    );
    const allowable = unique.filter((f) => !f.secret);
    if (allowable.length > 0) {
      console.error(
        `If a generic match is a false positive, add it to ${ALLOWLIST_FILE}` +
          (reveal ? ":" : " (run the check locally to see the exact keys).")
      );
      if (reveal) {
        allowable.forEach((f) => {
          console.error(`    ${generateAllowlistKey(f.file, f.match)}`);
        });
      }
    }
    process.exit(1);
  }

  console.log("✓ No private information detected in diff");
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
