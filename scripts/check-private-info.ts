#!/usr/bin/env npx tsx

/**
 * Scans git diff for private information patterns.
 * Flags: Swedish org numbers and personal IDs with valid checksums, bankgiro
 * and plusgiro numbers with valid checksums, IBAN numbers, private IP ranges,
 * and email addresses to real domains.
 *
 * Usage:
 *   check-private-info.ts [<base-sha>] [<head-sha>]
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
}

const ALLOWLIST_FILE = ".github/private-info-allowlist.txt";

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
  if (!century && month >= 20) return "org-number";

  if (century && century !== "19" && century !== "20") return null;
  // Samordningsnummer add 60 to the day.
  const realDay = day > 60 ? day - 60 : day;
  if (month < 1 || month > 12 || realDay < 1 || realDay > 31) return null;
  return "personal-id";
}

/** Bankgiro: NNN-NNNN or NNNN-NNNN with a valid Luhn check digit. */
export function isBankgiro(value: string): boolean {
  if (!/^\d{3,4}-\d{4}$/.test(value)) return false;
  // Year ranges like 2023-2024 have the same shape; never treat them as bankgiro.
  if (/^(19|20)\d{2}-(19|20)\d{2}$/.test(value)) return false;
  return luhnValid(value.replace("-", ""));
}

/** Plusgiro: 4 to 7 digits, hyphen, check digit, with a valid Luhn checksum. */
export function isPlusgiro(value: string): boolean {
  if (!/^\d{4,7}-\d$/.test(value)) return false;
  return luhnValid(value.replace("-", ""));
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
  // Allow example.* and testing domains (test, localhost, etc.)
  const allowedPatterns = [
    /^.+@example\./,
    /^.+@test\./,
    /^.+@localhost$/,
    /^.+@(127\.0\.0\.1|192\.0\.2\.|10\.|172\.16\.|192\.168\.).*$/,
  ];
  return !allowedPatterns.some((p) => p.test(email));
}

interface Detector {
  regex: RegExp;
  label: (value: string) => string | null;
}

// Digit-run detectors use (?<![\d-]) / (?![\d-]) so a match never starts or
// ends inside a longer number, date or ID (e.g. bankgiro inside an org number).
const DETECTORS: Detector[] = [
  {
    regex: /(?<![\d-])(?:\d{2})?\d{6}[-+]\d{4}(?![\d-])/g,
    label: (v) => {
      const kind = classifySwedishId(v);
      if (kind === "org-number") return "Swedish org number (valid checksum)";
      if (kind === "personal-id") return "Swedish personal ID (valid checksum)";
      return null;
    },
  },
  {
    regex: /(?<![\d-])\d{3,4}-\d{4}(?![\d-])/g,
    label: (v) => (isBankgiro(v) ? "Bankgiro number (valid checksum)" : null),
  },
  {
    regex: /(?<![\d-])\d{4,7}-\d(?![\d-])/g,
    label: (v) => (isPlusgiro(v) ? "Plusgiro number (valid checksum)" : null),
  },
  {
    // IBAN numbers (SE + 2 digits + alphanumeric)
    regex: /\bSE\d{2}[A-Z0-9]{1,30}\b/g,
    label: () => "IBAN number",
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

export function scanLine(
  content: string,
  lineNum: number,
  file: string,
  allowlist: Set<string>
): Finding[] {
  const findings: Finding[] = [];
  for (const { regex, label } of DETECTORS) {
    for (const match of content.matchAll(regex)) {
      const pattern = label(match[0]);
      if (!pattern) continue;
      if (allowlist.has(generateAllowlistKey(file, match[0]))) continue;
      const index = match.index ?? 0;
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
  return findings;
}

/** Scans the added lines of a unified diff. */
export function scanDiff(diffOutput: string, allowlist: Set<string>): Finding[] {
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
      // Allowlist entries repeat the values they approve.
      if (currentFile === ALLOWLIST_FILE) continue;
      findings.push(
        ...scanLine(line.substring(1), currentLineNum, currentFile, allowlist)
      );
    } else if (line.startsWith(" ")) {
      currentLineNum++;
    }
  }
  return findings;
}

const isUnexpanded = (arg: string) => arg.includes("${{") || arg.includes("}}");

/** Treats empty values and unexpanded CI expressions as missing. */
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

function main() {
  const refs = resolveRefArgs(process.argv.slice(2));

  let diffOutput: string;
  try {
    const baseSha = refs.base ?? defaultBase();
    const headSha = refs.head;
    const range = headSha ? [`${baseSha}...${headSha}`] : [baseSha];
    diffOutput = git(["diff", ...range, "--unified=0", "--no-color"]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to get git diff: ${message}`);
    process.exit(4);
  }

  const findings = scanDiff(diffOutput, loadAllowlist());

  if (findings.length > 0) {
    console.error("❌ Private information found in diff:\n");
    findings.forEach((f) => {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`    Pattern: ${f.pattern}`);
      console.error(`    Found: ${f.match}`);
      console.error(`    Context: ...${f.context}...`);
      console.error("");
    });
    console.error(
      `\n⚠️  If these are false positives, add them to ${ALLOWLIST_FILE}:`
    );
    findings.forEach((f) => {
      console.error(`    ${generateAllowlistKey(f.file, f.match)}`);
    });
    process.exit(1);
  }

  console.log("✓ No private information detected in diff");
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
