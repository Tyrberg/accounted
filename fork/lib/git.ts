/**
 * Every git invocation the fork layer is allowed to make.
 *
 * The routine runs unattended on a schedule against a checkout a human also
 * uses, so it must not be able to move HEAD, rewrite history, stage anything
 * or touch a remote other than the one the manifest names. That is enforced
 * here rather than by convention: {@link runGit} refuses any argv that is not
 * on {@link ALLOWED_GIT_INVOCATIONS}, and a test walks a full mocked run to
 * prove nothing outside the list is ever issued.
 *
 * `worktree add --detach` is the one entry that writes anything. It writes a
 * scratch checkout OUTSIDE the repo plus bookkeeping under .git/worktrees, and
 * leaves HEAD, the index and every branch untouched. It is on the list because
 * running upstream's own test suite at upstream's tip is impossible without it,
 * and a "did upstream go red" answer produced from our frozen tree would be a
 * lie.
 */

import type { CommandResult, Runner } from './exec'
import { formatCommand, PLUMBING_TIMEOUT_MS } from './exec'
import type { Tree } from './checks'

/**
 * Matchers for the permitted argv shapes. Each takes the full argument list
 * (without the leading `git`) and decides whether it is that invocation.
 */
export const ALLOWED_GIT_INVOCATIONS: readonly { id: string; matches: (args: readonly string[]) => boolean }[] = [
  { id: 'fetch', matches: (a) => a[0] === 'fetch' && a[1] === '--no-tags' && a.length === 3 },
  { id: 'show', matches: (a) => a[0] === 'show' && a.length === 2 },
  {
    id: 'diff-name-only',
    matches: (a) => a[0] === 'diff' && a[1] === '--name-only' && a.length === 3,
  },
  { id: 'rev-parse', matches: (a) => a[0] === 'rev-parse' && a.length === 2 },
  {
    id: 'rev-list-count',
    matches: (a) => a[0] === 'rev-list' && a[1] === '--count' && a.length === 3,
  },
  { id: 'log-one', matches: (a) => a[0] === 'log' && a[1] === '-1' && a.length === 4 },
  { id: 'remote', matches: (a) => a[0] === 'remote' && a.length === 1 },
  {
    id: 'remote-get-url',
    matches: (a) => a[0] === 'remote' && a[1] === 'get-url' && a.length === 3,
  },
  {
    id: 'worktree-add',
    matches: (a) => a[0] === 'worktree' && a[1] === 'add' && a[2] === '--detach' && a.length === 5,
  },
  {
    id: 'worktree-remove',
    matches: (a) => a[0] === 'worktree' && a[1] === 'remove' && a[2] === '--force' && a.length === 4,
  },
]

export class DisallowedGitCommandError extends Error {}

export function isAllowedGitInvocation(args: readonly string[]): boolean {
  return ALLOWED_GIT_INVOCATIONS.some((entry) => entry.matches(args))
}

export function runGit(
  runner: Runner,
  cwd: string,
  args: readonly string[],
  timeoutMs = PLUMBING_TIMEOUT_MS,
): CommandResult {
  if (!isAllowedGitInvocation(args)) {
    throw new DisallowedGitCommandError(
      `refusing to run "${formatCommand('git', args)}": not on the fork layer's read-only allowlist`,
    )
  }
  return runner('git', args, { cwd, timeoutMs })
}

/**
 * A {@link Tree} backed by `git show <ref>:<path>`.
 *
 * A non-zero exit is treated as "no such file at that ref", which is exactly
 * what git reports for a missing path. A fetch failure is handled earlier, by
 * refusing to build this tree at all, so a dead remote can never masquerade as
 * a repository full of deleted files.
 */
export function upstreamTree(runner: Runner, cwd: string, ref: string): Tree {
  return {
    read(path) {
      const result = runGit(runner, cwd, ['show', `${ref}:${path}`])
      if (result.code !== 0) return null
      return result.stdout
    },
  }
}

export interface RemoteState {
  /** true when the manifest's remote is configured in this checkout. */
  hasRemote: boolean
  remotes: string[]
}

export function readRemotes(runner: Runner, cwd: string, remote: string): RemoteState {
  const result = runGit(runner, cwd, ['remote'])
  const remotes = result.code === 0
    ? result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : []
  return { hasRemote: remotes.includes(remote), remotes }
}

/** The configured fetch URL of a remote, or null when git cannot report one. */
export function readRemoteUrl(runner: Runner, cwd: string, remote: string): string | null {
  const result = runGit(runner, cwd, ['remote', 'get-url', remote])
  if (result.code !== 0) return null
  const url = result.stdout.trim()
  return url === '' ? null : url
}

/**
 * Does `url` point at `owner/name` on any host?
 *
 * A remote named `upstream` proves nothing about where it points: it can be
 * repointed by hand or inherited from a differently-configured clone, and the
 * whole routine would then fetch, diff and gate against a stranger's
 * repository while reporting success. The manifest declares the repository it
 * means, so the URL is checked against that declaration rather than trusted.
 *
 * Accepts both `https://host/owner/name(.git)` and `git@host:owner/name(.git)`
 * shapes, plus a trailing slash, and compares case-insensitively because git
 * hosts treat owner and repository names that way.
 */
export function remoteMatchesRepo(url: string, repo: string): boolean {
  const normalise = (value: string) =>
    value.trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()
  const normalisedUrl = normalise(url)
  const wanted = normalise(repo)
  if (wanted === '') return false
  const segments = normalisedUrl.split(/[/:]/).filter(Boolean)
  if (segments.length < 2) return false
  return segments.slice(-2).join('/') === wanted
}

export function fetchUpstream(runner: Runner, cwd: string, remote: string): CommandResult {
  return runGit(runner, cwd, ['fetch', '--no-tags', remote])
}

/** Files that differ between upstream's tip and ours (merge-base diff, `...`). */
export function changedVersusUpstream(
  runner: Runner,
  cwd: string,
  ref: string,
): { ok: true; paths: string[] } | { ok: false; error: string } {
  const result = runGit(runner, cwd, ['diff', '--name-only', `${ref}...HEAD`])
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || `git diff against ${ref} failed` }
  }
  return {
    ok: true,
    paths: result.stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  }
}

export interface RefDescription {
  sha: string
  committedAt: string
}

export function describeRef(
  runner: Runner,
  cwd: string,
  ref: string,
): RefDescription | null {
  const sha = runGit(runner, cwd, ['rev-parse', ref])
  if (sha.code !== 0) return null
  const when = runGit(runner, cwd, ['log', '-1', '--format=%cI', ref])
  return {
    sha: sha.stdout.trim(),
    committedAt: when.code === 0 ? when.stdout.trim() : 'unknown',
  }
}

/** How many upstream commits are not in HEAD. 0 means the fork is caught up. */
export function countBehind(runner: Runner, cwd: string, ref: string): number | null {
  const result = runGit(runner, cwd, ['rev-list', '--count', `HEAD..${ref}`])
  if (result.code !== 0) return null
  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isNaN(count) ? null : count
}

/** How many of our commits are not in upstream. Should stay small: see fork/README.md. */
export function countAhead(runner: Runner, cwd: string, ref: string): number | null {
  const result = runGit(runner, cwd, ['rev-list', '--count', `${ref}..HEAD`])
  if (result.code !== 0) return null
  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isNaN(count) ? null : count
}
