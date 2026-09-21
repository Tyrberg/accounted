# Fork maintenance

How we track `erp-mafia/accounted` without slowly turning our copy into a
different product.

This directory is the whole of our fork layer. Nothing outside `fork/` is
modified, so `git diff upstream/main...HEAD` should list `fork/` paths and
nothing else. That is not an aesthetic preference: every upstream file we touch
is a file that has to be merged, by hand, forever.

That rule is why this document is here rather than in the root `README.md` or
in `docs/`, why there are no `fork:*` entries in `package.json`, and why fork
decisions go in [`fork/DECISIONS.md`](DECISIONS.md) instead of the root
`DECISIONS.md`. Each of those would have been more discoverable and each would
have cost a permanently conflicting file. The trade is recorded in
[`fork/DECISIONS.md`](DECISIONS.md); reverse it deliberately if discoverability
turns out to matter more.

**Contents**

1. [The situation](#1-the-situation)
2. [Catch-up status and what was verified](#2-catch-up-status-and-what-was-verified)
3. [The database is the real gap](#3-the-database-is-the-real-gap)
4. [Adaptation strategy](#4-adaptation-strategy)
5. [The sync routine](#5-the-sync-routine)
6. [How to upgrade](#6-how-to-upgrade)
7. [How to contribute back upstream](#7-how-to-contribute-back-upstream)
8. [AGPL-3.0 section 13: what running a modified copy obliges us to do](#8-agpl-30-section-13-what-running-a-modified-copy-obliges-us-to-do)
9. [The GitLab copy](#9-the-gitlab-copy)
10. [Not live yet](#10-not-live-yet)
11. [Switching on the Underlagsjakt delivery](#11-switching-on-the-underlagsjakt-delivery)

---

## 1. The situation

This is not our project. It is `erp-base`, copyright Arcim, licensed
AGPL-3.0-or-later, developed at `github.com/erp-mafia/accounted` (previously
named `gnubok`). See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

| Remote     | Points at                    | Role                                   |
| ---------- | ---------------------------- | -------------------------------------- |
| `origin`   | `github.com/Tyrberg/accounted` | Our fork. Where our branches live.     |
| `upstream` | `github.com/erp-mafia/accounted` | The real project. Read-only for us.  |
| `gitlab`   | `gitlab.atteq.com/...`       | An older copy. See section 9.          |

**The standing principle:** we do not develop this product. We follow upstream,
we keep our adaptations minimal and separate, and anything that is a general
improvement goes back to upstream as a pull request rather than living here.

---

## 2. Catch-up status and what was verified

The order behind this layer described the fork as 508 commits behind. That
number was measured on the old working clone (`~/Dropbox/Mycode/gnubok-backoffice`,
sitting at `ed9bdc4` from 2026-05-11), not on the fork itself.

The distinction matters, because it changes what "catching up" means:

- **The fork had no commits of its own when this was written.** Catching up
  was therefore a fast-forward, not a merge. That stopped being true on
  2026-08-29: three commits landed on `main` (the fork maintenance layer
  itself, the SIE 8-year migration validation instrument, and three
  contributed-back self-hosting bug fixes), so `git merge --ff-only
  upstream/main` is no longer guaranteed to succeed. It failed for exactly
  that reason during the 2026-09-05 catch-up; see step 3 of section 6 and
  [`fork/DECISIONS.md`](DECISIONS.md).
- The working clone on the box (`/opt/projects/accounted`) was created fresh
  from the fork on 2026-07-30, so it starts at upstream's tip rather than at
  the 2026-05-11 snapshot.
- The only known local adaptation, `docker-compose.override.yml`, was never
  committed, so it could not have been reverted by the jump either.

**Verified in this checkout, at the tip this layer was written against:**

| Check                                    | Result                                                          |
| ---------------------------------------- | --------------------------------------------------------------- |
| `npm ci`                                 | Clean, 1087 packages.                                            |
| `npm test`                               | Green: 950 files passed, 2 skipped; 12060 tests passed, 4 skipped; ~85s. Of that, this layer is 9 files and 111 tests, so upstream's own suite is 941 files and 11949 tests, all passing. |
| `npm run check:lint`                     | Green: 0 errors against a baseline of 0.                         |
| `npm run check:guards`                   | Green.                                                           |
| `npx tsc --noEmit`                       | No diagnostics under `fork/`. The repo-wide run reports 505 pre-existing errors in `app/**/__tests__`, untouched by this change and not part of any CI gate. |
| Migration inventory 2026-05-11 to now    | 611 files, see section 3.                                        |

**Not verified here, and why:**

| Not verified                             | Why                                                             |
| ---------------------------------------- | --------------------------------------------------------------- |
| `npm run test:pg`                        | Needs a real Postgres (`DATABASE_URL`); none in this checkout.   |
| That the app boots and serves            | Needs Supabase credentials and a database.                       |
| Upstream anchors at upstream's real tip  | This checkout has no `upstream` remote. That is the weekly run's job (section 5). |
| Migrations applied against a live schema | Needs a backup restore. See section 3, and it is a decision, not a task. |

Anything the sync routine did not inspect is printed as such in its report. A
report that quietly covers less than it appears to is the specific failure this
layer is built to prevent, so it is worth repeating: the table above is the
honest boundary.

---

## 3. The database is the real gap

Source code fast-forwards cleanly. Schemas do not. Any environment still
running the 2026-05-11 schema has this much to apply:

| Window                       | Migration files |
| ---------------------------- | --------------- |
| 2026-05 (from the 11th)      | 135             |
| 2026-06                      | 67              |
| 2026-07                      | 171             |
| 2026-08                      | 182             |
| 2026-09 (through the 4th)    | 56              |
| **Total from 2026-05-11**    | **611**         |
| Total in `supabase/migrations/` | 786          |

First in the window: `20260511120000_bank_connections_pending_selection.sql`.
Last in the window: `20260904163000_fiscal_year_reset_next_year_dependency.sql`.

Regenerate this inventory at any time with:

```bash
ls supabase/migrations | grep '\.sql$' | awk '$0 >= "20260511"' | wc -l
ls supabase/migrations | grep '\.sql$' | awk '$0 >= "20260511"' | cut -c1-6 | sort | uniq -c
```

The `grep '\.sql$'` matters: `supabase/migrations/` also contains a
`__tests__/` subdirectory, and string comparison sorts `_` after digits, so
`"__tests__" >= "20260511"` is true and an unfiltered `ls` silently counts
that directory as a phantom migration. (The command above did exactly that
the first time this table was regenerated, reporting 612 rather than 611 from
2026-05-11, with a bogus `1 __test` line in the by-month breakdown. Filed here
so nobody re-derives it from scratch.)

Rules that apply to every one of those files, from [CLAUDE.md](../CLAUDE.md):
an existing migration is never edited, the enforcement triggers in migration
017 are never touched, and the remote database must never be left ahead of the
repo.

**The procedure for a schema jump, in order:**

1. Restore the most recent production backup into a scratch database.
2. Apply the pending migrations there, in filename order, and record where it
   stops if it stops.
3. Run `DATABASE_URL=<scratch> npm run test:pg` against the scratch database.
   The pg-real suite is what actually exercises the triggers, RPCs, RLS
   policies and deferrable constraints that the unit suite mocks away.
4. Only then apply to the live database, and only with a fresh backup taken
   immediately beforehand.

**Open operations decision (q657-1).** For a deployment still on the old
schema, there are two ways out: pin the Docker image to the version matching
the current schema and stay there, or take the migrations and move forward. The
recommendation from this side is to move forward, because pinning accumulates
the same 611-file jump plus interest and there is no supported path that
skips migrations. But it is a production decision about a live database, it is
not made by this repository, and nothing in `fork/` performs it: the sync
routine is read-only and cannot touch a database at all.

---

## 4. Adaptation strategy

Two tiers, in strict order of preference.

### Tier 1: configuration, environment, extension points (always try this first)

Upstream already provides the seams. Use them:

| Need                                   | Seam                                                                |
| -------------------------------------- | ------------------------------------------------------------------- |
| Deployment shape (ports, limits, volumes, extra services) | `docker-compose.override.yml` on the host, which upstream's [docs/DOCKER.md](../docs/DOCKER.md) documents as the sanctioned mechanism |
| Secrets and per-environment values     | `.env`, already loaded by upstream's compose file via `env_file`      |
| Feature toggles                        | `NEXT_PUBLIC_SELF_HOSTED`, `NEXT_PUBLIC_REQUIRE_MFA` and friends in [.env.example](../.env.example) |
| Optional functionality                 | `extensions.config.json` plus `extensions/general/*`, opt-in by design |
| Branding                               | [docs/WHITELABEL.md](../docs/WHITELABEL.md)                          |
| Scheduled jobs                         | `vercel.json` is the source of truth; `npm run crontabs:generate` emits the Docker crontabs |

A tier 1 adaptation modifies no upstream file, so it survives every upgrade by
construction. It can still *break*: Compose merges overrides by service name,
so if upstream renames the `app` service our override silently stops applying.
That is what the anchors in [adaptations.json](adaptations.json) are for.

**Where `docker-compose.override.yml` lives:** on each deployment box, at the
repository root, untracked. It is per host and it is the file people reach for
when they need a quick production tweak, which is exactly the kind of change
that must not end up in a fork commit. The committed, reviewed, secret-free
template is [`fork/templates/docker-compose.override.example.yml`](templates/docker-compose.override.example.yml):

```bash
cp fork/templates/docker-compose.override.example.yml docker-compose.override.yml
# then edit the copy on the box
```

If someone commits the live override by accident, the weekly run says so by
name rather than filing it under generic drift.

### Tier 2: a thin patch series (the exception)

When something genuinely cannot be expressed as configuration:

- It lives on the branch `fork/patches`, which is rebased onto each upstream
  release tag. Never merged into `main`, so `main` stays a clean mirror of
  upstream and the patch set stays visible as a list rather than dissolving
  into history.
- One commit per concern, with a commit message that says what it does, why
  configuration was not enough, and the upstream PR link once we have filed
  one.
- **It must be declared in [`fork/adaptations.json`](adaptations.json)** with at
  least one `local-*` check that fails if the patch is reverted. The manifest
  parser enforces this: a tracked adaptation with only upstream checks is
  rejected, because an adaptation nothing local verifies could be wiped by a
  merge without anything going red.
- It is temporary by default. `upstream.status` moves `planned` to `proposed`
  to `merged`, and once upstream ships it the weekly run tells us to delete our
  copy.

There is one tier 2 patch today, `docker-cron-entrypoint-hardening` (see
[`fork/adaptations.json`](adaptations.json)), and it is already a deviation
from the procedure above: it landed directly on `main` instead of on
`fork/patches`, before this rule was being enforced. Zero tier 2 patches
remains the target state; new ones follow the procedure above, on
`fork/patches`.

### The rule that keeps this honest

Every difference from upstream is declared in `fork/adaptations.json`, and the
weekly run reconciles the manifest against the real diff **in both directions**:
undeclared files are flagged, and so is a declared adaptation that has stopped
differing. A one-directional guard goes green in precisely the case we care
about, because a reverted file disappears from the diff.

---

## 5. The sync routine

### The two layers

**Layer 1: it runs inside `npm test`, so nobody has to remember it.**
`fork/__tests__/committed-manifest.test.ts` evaluates the committed manifest
against the real working tree. `npm test` runs it, and `core-build.yml` runs
`npm test` on every push. If an upstream merge reverts one of our adaptations,
that merge goes red in CI. No schedule, no remote, no configuration involved:
this half cannot silently stop.

What it cannot do is look at upstream, because CI has no `upstream` remote.

**Layer 2: the weekly run on the box, which can.**

```bash
npx tsx fork/cli.ts verify                     # offline: manifest + our tree
npx tsx fork/cli.ts sync --upstream-gates      # the weekly routine
npx tsx fork/cli.ts status                     # is the schedule still alive?
```

`sync` first checks that the remote named in the manifest actually points at
the repository the manifest declares (`erp-mafia/accounted`) — a remote's name
is not evidence of its identity, and a repointed one would otherwise be
fetched, diffed and gated against while the run reported a clean sync of the
wrong repository. It then fetches upstream, resolves every anchor through `git
show upstream/main:<path>`, reconciles the diff both ways, runs the gates in
our tree, and (with `--upstream-gates`) runs them again in a throwaway detached
worktree at upstream's tip, so "is upstream green" is answered by upstream's
code rather than inferred from ours.

### Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | Everything checked, nothing wrong.                                     |
| 1    | Usage error, reserved for the launcher so a crash is never read as an alarm. |
| 2    | **An adaptation alarm.** One of ours broke, vanished, or something undeclared appeared. |
| 3    | A gate went red.                                                       |
| 4    | The run could not look: no remote, fetch failed, worktree failed, dev tooling missing. |

The code is the highest-priority category that fired, but the report always
prints one line per category, including a "deliberately skipped" section for
anything the flags told it not to do. Nothing is hidden by the ranking.

### Scheduling it

```cron
# /etc/cron.d/accounted-fork-sync
#
# System crontab format, which is not the same as `crontab -e`: field 6 is the
# user to run as, and there are no line continuations, so the command stays on
# one line however long it gets. Monday 04:17. Needs devDependencies installed
# (npm ci), or the gates report as "not run" and the routine exits 4 rather
# than pretending.
PATH=/usr/local/bin:/usr/bin:/bin
FORK_SYNC_ALERT_REPO=Tyrberg/accounted
FORK_SYNC_HEARTBEAT_URL=https://hc-ping.com/REPLACE-WITH-YOUR-CHECK-UUID
17 4 * * 1 deploy cd /opt/projects/accounted && npx tsx fork/cli.ts sync --upstream-gates >> fork/state/sync.log 2>&1 && curl -fsS --max-time 10 "$FORK_SYNC_HEARTBEAT_URL" >/dev/null
```

Replace `deploy` with the user that owns the clone, and end the file with a
newline: cron ignores a last line without one. Without a heartbeat check, drop
the `FORK_SYNC_HEARTBEAT_URL` line and the trailing `&& curl ...` rather than
leaving the variable empty, which would make every successful run end in a
failed `curl`.

The log goes to `fork/state/sync.log` inside the clone, not to `/var/log`, on
purpose: the redirection is opened by the shell as the cron user **before** the
command runs, so a `/var/log/...` destination that user cannot create makes the
job die at that redirect every week without ever executing the sync — silent in
exactly the way this routine exists to prevent. `fork/state/` is owned by the
clone owner and already gitignored, so it is writable by definition. Prefer
`/var/log` only after provisioning the file for that user, e.g.
`sudo install -o deploy -g deploy -m 0644 /dev/null /var/log/accounted-fork-sync.log`
plus a logrotate entry.

**Why a cron on the box and not a GitHub Actions workflow.** Two reasons, both
decisive. GitHub does not run `on: schedule` workflows in forked repositories
at all, so a scheduled workflow committed here would never fire; and
`.github/workflows/` is upstream-owned, so anything we add there is permanent
merge surface of the exact kind section 4 exists to avoid. The clone that needs
watching is on the box, and so is the job that watches it.

### How it makes noise

1. **Exit code**, for whatever wrapper runs it.
2. **A written report** at `fork/state/last-report.md`, plus machine-readable
   state at `fork/state/last-sync.json`. Both are gitignored (see
   [`fork/state/.gitignore`](state/.gitignore)); they are per checkout and per
   run.
3. **A GitHub issue**, when `FORK_SYNC_ALERT_REPO` is set and the `gh` CLI is
   authenticated on the box. When it is not, the run says so in its output
   rather than implying an alert went out.
4. **Staleness, which is its own alarm.** A scheduled job that quietly died
   looks exactly like a scheduled job with nothing to report.
   `npx tsx fork/cli.ts status` reads the last recorded run and exits non-zero
   once it is older than `maxSyncAgeDays` (10) or if the last run's alarm was
   never cleared.
5. **A dead-man's switch, for the case none of the above can catch.** If the
   box is off, nothing on the box can tell you. The `curl` in the crontab above
   pings an external check (healthchecks.io or equivalent) only on a
   zero-exit run, so both "the job failed" and "the job never ran" alert from
   outside. Set `FORK_SYNC_HEARTBEAT_URL` in the cron environment to enable it.

### What it will never do

The routine only issues git commands from a read-only allowlist in
[`fork/lib/git.ts`](lib/git.ts): `fetch`, `show`, `diff`, `rev-parse`,
`rev-list`, `log`, `remote` (including `remote get-url`), and the two
`worktree` calls that build and remove
the scratch checkout outside the repository. `merge`, `rebase`, `checkout`,
`reset`, `pull`, `push`, `commit`, `add`, `clean` and `stash` are refused, and a
test walks a full run to prove none of them is ever issued. Taking the upgrade
is a human decision; the routine only tells you what it would cost.

---

## 6. How to upgrade

```bash
cd /opt/projects/accounted
```

1. **Read the last report first.** `npx tsx fork/cli.ts status`, then
   `cat fork/state/last-report.md`. If the weekly run already found something,
   that is the upgrade's actual work.
2. **See the distance.** `git fetch upstream && git log --oneline HEAD..upstream/main`.
   Skim the migration filenames in the range: that is the risky part.
3. **Fast-forward `main`.** `git checkout main && git merge --ff-only upstream/main`.
   If that fails, check first whether it is one of the fork's own commits on
   `main` (`fork/`, `lib/import/sie-migration-validation.ts`,
   `docker/cron.Dockerfile`; see [`fork/adaptations.json`](adaptations.json))
   rather than something that should not have been committed at all. If it is
   a declared adaptation, a real merge is the correct move: `git merge
   upstream/main` on a dedicated branch (never straight onto `main`), so the
   fork's commits are preserved rather than discarded. Expect the only
   conflicts to be append-only doc files upstream and the fork both write to
   (the root `DECISIONS.md` is the known case; keep both sides' lines). If the
   failure is anything else, something has been committed to `main` that
   should not have been; find it before going further.

   The dedicated branch still has to land on `main` before steps 4-8 mean
   anything: open a PR from it, get it reviewed and merged through the normal
   process (this repo has no direct-push exception for fork syncs), then
   `git checkout main && git pull` to pick up the merge before continuing.
   Steps 4-8 below run against `main` after that merge has landed, not
   against the dedicated branch. (Precedent: the 2026-09-05 catch-up hit this
   exact fallback, on branch `fork-sync/upstream-2026-09-05`, merged via
   accounted#5.)
4. **Reinstall and re-verify.** `npm ci`, then `npm test`, `npm run check:lint`,
   `npm run check:guards`.
5. **Check the adaptations.** `npx tsx fork/cli.ts sync`. Exit 2 means an
   adaptation broke, and the report names it, says what changed upstream, and
   quotes the reason recorded in the manifest.
6. **Rebase tier 2, if any exists.** Check each tier 2 adaptation's declared
   `branch` in [`fork/adaptations.json`](adaptations.json) first, they are not
   all on `fork/patches`: `docker-cron-entrypoint-hardening` declares
   `"branch": "main"` (the documented section-4 deviation), and a patch
   declared on `main` travels with step 3's merge, there is nothing to rebase
   for it, just re-run step 5 to confirm its checks still hold. For any
   adaptation actually declared on `fork/patches`, run `git rebase
   upstream/main fork/patches`, then re-run step 5. Either way, drop any patch
   whose upstream PR has been merged, and delete its manifest entry in the
   same commit.
7. **Do the database.** Section 3. Backup restore, scratch database,
   `npm run test:pg`, then live.
8. **Push and deploy.** Steps 4-7 routinely leave local commits on `main`
   regardless of which path step 3 took: an adaptation fix from a step 5 exit
   2, the step 6 rebase of `fork/patches` and the manifest-entry deletion
   that goes with it. Run `git status` and `git log origin/main..HEAD`; if
   either shows anything, `git push origin main` before deploying. This holds
   even in the merge-fallback path, where `main` was only caught up to
   `origin` as of the PR merge in step 3, not after steps 4-7 ran. Either way,
   finish with the deployment's own procedure
   ([docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md)).

`npm run check:lint` and `npm run check:guards` are ratchets, not absolutes:
they compare against a committed baseline of known-legacy findings. A jump that
adds new findings fails them even though upstream's own CI is green on the same
commit, because the baselines are recomputed upstream. If that happens, the
finding is upstream's and the fix belongs in a PR to upstream (section 7), not
in a local baseline edit.

---

## 7. How to contribute back upstream

If a fix is not specific to us, it goes upstream. A general fix carried locally
is a permanent tax on every future upgrade, and it deprives the project that we
depend on.

1. Branch from `upstream/main`, not from a fork branch:
   `git fetch upstream && git checkout -b fix/<thing> upstream/main`.
2. Follow upstream's own rules in [CONTRIBUTING.md](../CONTRIBUTING.md) and
   [CLAUDE.md](../CLAUDE.md): conventional commit, tests for new logic in `lib/`
   or `app/api/`, both `messages/sv.json` and `messages/en.json` for new UI
   strings, English for all code and commits.
3. **Sign off every commit** (`git commit -s`). Upstream requires the Developer
   Certificate of Origin; an unsigned commit will not be accepted.
4. `npm run lint && npm test && npm run build` before opening the PR.
5. Push to `origin` and open the PR against `erp-mafia/accounted`.
6. If we need the fix before it merges, carry it as a tier 2 patch with
   `upstream.status: "proposed"` and the PR link in the manifest. The parser
   requires the link. When it merges, the weekly run notices that our patch no
   longer differs from upstream and tells us to delete it.

---

## 8. AGPL-3.0 section 13: what running a modified copy obliges us to do

Accounted is licensed AGPL-3.0-or-later. Section 13 of the AGPL is the clause
that separates it from the ordinary GPL:

> Notwithstanding any other provision of this License, if you modify the
> Program, your modified version must prominently offer all users interacting
> with it remotely through a computer network [...] an opportunity to receive
> the Corresponding Source of your version by providing access to the
> Corresponding Source from a network server at no charge, through some
> standard or customary means of facilitating copying of software.

Read against what we are actually doing:

- **We modify the Program.** Everything in `fork/` is a modification, however
  carefully quarantined. A tier 2 patch would be one too. Even a
  configuration-only deployment stops being "unmodified" the moment we commit
  anything.
- **We run it as a network service.** Our own companies' staff use it over the
  network. Section 13 says "all users interacting with it remotely", and it
  makes no exception for internal, employee-only or single-tenant use. Users
  are users.
- **Therefore we must offer them the Corresponding Source of our version, free
  of charge, over the network.** Not on request, not by email: offered
  prominently, from a network server.

**What that means in practice:**

1. Keep `github.com/Tyrberg/accounted` **public**, and keep the running
   deployment's commit pushed to it. A private fork running as a service is a
   licence violation the moment a user touches it.
2. Put a visible source link in the running application pointing at the exact
   revision being served, not just at the project. The repository's own
   whitelabel and branding surfaces are where that link belongs; check it after
   any rebrand, because "prominently offer" is the operative phrase.
3. If we ever deploy a build that is not pushed anywhere public, the source
   offer has to come from somewhere else we control, and it has to be
   Corresponding Source for **that** build.
4. Keep [LICENSE](../LICENSE) and [NOTICE](../NOTICE) intact. Copyright stays
   with Arcim; AGPL-3.0-or-later does not become ours by forking, and section 13
   binds us as a downstream operator.

This is the strongest practical argument for the tier 1 preference: the smaller
our modification, the smaller the surface where "what exactly are we running,
and is that revision published" can go wrong.

None of the above is legal advice. It is the reading this layer is built on,
and it is the conservative one.

---

## 9. The GitLab copy

`gitlab.atteq.com` holds an older copy of the project, still configured as a
remote named `gitlab` on the old working clone.

**Recommendation: retire it as a fork, keep it as a read-only archive.**

Two real forks means two answers to "what are we running", and section 8 makes
that question a compliance question, not a matter of taste. `Tyrberg/accounted`
is the real fork: it is a GitHub fork of upstream, so it can send pull requests
back, and it is public, which is what the AGPL source offer needs. The GitLab
copy can do neither.

Concretely, and in this order:

1. Mark the GitLab project archived or read-only in the GitLab UI, and put a
   line in its description pointing at `github.com/Tyrberg/accounted`.
2. Remove the `gitlab` remote from working clones once nothing references it:
   `git remote remove gitlab`.
3. **Delete nothing.** The copy stays. It is history, and it costs nothing to
   keep.

**Credential warning.** The `gitlab` remote URL in the old clone's
`.git/config` embeds a GitLab personal access token (a `glpat-` prefixed
secret) in cleartext. It is not reproduced anywhere in this repository and must
not be. It needs to be handled by a person with GitLab admin access:

1. Revoke that token in GitLab (User settings, Access Tokens). Assume it is
   compromised: it has been sitting unencrypted in a config file inside a
   Dropbox-synced directory.
2. Rewrite the remote URL without the credential, or drop the remote entirely
   per step 2 above.
3. If GitLab access is still needed afterwards, use a credential helper or SSH
   key, never an inline URL token.

Nothing in this repository can do any of that, and nothing here should try.

---

## 10. Not live yet

Everything below is real work that this directory does not perform, listed so
it cannot be mistaken for done.

| What                                              | Who / where                                  |
| ------------------------------------------------- | -------------------------------------------- |
| Install the crontab from section 5 on the box     | Whoever administers `/opt/projects/accounted` |
| Set `FORK_SYNC_ALERT_REPO`, authenticate `gh`     | Same                                          |
| Create the external heartbeat check and set `FORK_SYNC_HEARTBEAT_URL` | Same                  |
| First real `sync` run against a checkout that has the `upstream` remote | Same. Until then the upstream half of the routine has never executed end to end |
| Decide q657-1 (pin the image vs take the migrations) | Mattias, per section 3                     |
| The 611-migration schema jump, if any environment is still on the old schema | Follows from q657-1  |
| Revoke and remove the GitLab `glpat-` token       | Whoever has GitLab admin, per section 9       |
| Archive the GitLab project as read-only           | Same                                          |
| Underlagsjakt: bertil's `--json` export read into `/e/general/underlagsjakt`, answers downloaded and fed to `--mottak-svar` | Mattias, after this fork is deployed to his instance. Until then no real post has been shown there |
| Underlagsjakt automatic delivery: all five switch-on steps in [section 11](#11-switching-on-the-underlagsjakt-delivery), from minting the token to scheduling the standing check. Concretely: `UNDERLAGSJAKT_LEVERANS_TOKEN` + `UNDERLAGSJAKT_LEVERANS_ORGNR` in the Accounted box's `.env`; `GNUBOK_API_URL` + `GNUBOK_API_KEY` in bertil's; `/etc/cron.d/underlagsjakt-leverans` installed on bertil's box; one real export and one real answer carried; then `/etc/cron.d/underlagsjakt-status` plus its own external heartbeat check on the Accounted box | Whoever administers the two boxes. Four of the five steps happen outside this repository, and nothing in a pull request can reach either machine. Until `npx tsx extensions/general/underlagsjakt/leverans-status.ts` exits 0 on the box, the delivery is code that has never run, and the box says so on every run rather than leaving it to this table. Step 5 is what keeps it saying so without anyone remembering to ask |
| Underlagsjakt: teach the extension bertil's next contract version once bertil#180 (the `reglering` field) is merged; until then the settlement is kept in Accounted only | Whoever takes the follow-up task |
| Underlagsjakt: the upload option in the answer form is OFF (not shown, and `POST /svar/underlag` answers 403) until `UNDERLAGSJAKT_UPLOAD_ENABLED=true` is set in the Accounted box's `.env`. Set it only after bertil's `mottak_svar_fran_ui` reads answer version 1.5 and the `uppladdat_underlag` svarstyp (spec: docs/underlagsjakt-export-schema.md, "Answers"). Only an answer file that holds an upload is written as 1.5; every other file stays 1.4, so nothing changes for bertil before then. Until it is on, Mattias still has no way to hand over the receipt in the form | Whoever takes the bertil task, then whoever administers the Accounted box. Nothing in this repository can change bertil or the box |

---

## 11. Switching on the Underlagsjakt delivery

Section 10 lists this as not live. This section is the whole of what "live"
takes: five steps across two boxes, no code changes anywhere. Steps 2 and 5
touch this repository's deployment; the rest is bertil's box, which nothing
here can reach, so none of it can be performed from a pull request. Step 5
installs the schedule that keeps checking afterwards, so the delivery going
quiet is an alarm rather than something someone notices weeks later.

The endpoints, the contract and the failure codes are documented in
[`docs/underlagsjakt-export-schema.md`](../docs/underlagsjakt-export-schema.md).
What follows is the operator order, with the check that has to pass before
moving on.

### Step 1: mint the secret

On either box, once:

```bash
openssl rand -base64 24    # 32 characters; the app refuses anything shorter
```

It goes into two `.env` files and nowhere else: never into this repository,
never into bertil's, never into a ticket (task 1453 is why).

### Step 2: the Accounted box

Add to the deployment's `.env`, next to the other secrets:

```
UNDERLAGSJAKT_LEVERANS_TOKEN=<the value from step 1>
UNDERLAGSJAKT_LEVERANS_ORGNR=<org number of the company the export belongs to>
```

Then `docker compose up -d app`. No compose edit is needed: `docker-compose.yml`
hands the whole `.env` to the app through `env_file`.

Confirm it took, on the box, in the clone:

```bash
npm install            # once per clone: the check runs this code, not the image's
npx tsx extensions/general/underlagsjakt/leverans-status.ts
```

It reads the deployment's `.env` itself, the same file compose hands the app,
so nothing has to be exported into the shell first: run it from anywhere in
the clone. Then it resolves the company exactly as a delivery does and reports
what the machine path has actually carried. It writes nothing, and it never
calls `GET /svar`. Its first line names the file it read, so a wrong answer
can be told from a wrong place to look. Its exit code is the whole verdict:

| Exit | What it means |
| --- | --- |
| `4` | Nothing to check: the variables are unset, one of them is set to something unusable (a hand-typed token, an org number with a mistyped digit), or the org number names no single active company. The configuration headline distinguishes "not switched on", "configured wrong", and "partly missing and partly invalid". The line names each problem and says "Add" for each missing variable and "Correct" for each invalid one, so a mixed configuration gets both actions. Report framing is English; shared API error details remain Swedish. It also says which `.env` was read or that none was found. Fix and rerun before going further. |
| `2` | Configured and resolving, but nothing has come through yet. **This is the expected answer at this point**, and it stays the answer until step 4 succeeds. |
| `0` | Both directions have carried real data, recently. Only step 4 can produce this. |

The same command is the standing check afterwards: a delivery that was never
scheduled and one whose schedule died both look like silence, so it alarms
(exit 2) once **either** direction goes more than two days without being used.
Each half is dated on its own, because they stop independently: a client whose
export call started failing keeps collecting answers every morning, and a
broken collection leaves exports arriving. Only the half that went quiet is
named in the line. That alarm
is only worth anything if something runs the command without being asked, so
[step 5](#step-5-schedule-the-standing-check-on-the-accounted-box) puts it in
`/etc/cron.d` on this box, the same way section 5 schedules the sync.

The token itself can be checked from anywhere that can reach the box. This
probe writes nothing either: the token check and the company lookup run first,
and the empty body is then rejected by the contract rules before anything is
stored.

```bash
curl -s -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{}' https://bokforing.bohed.com/api/extensions/ext/underlagsjakt/export
```

| Answer | What it means |
| --- | --- |
| `400` (for this body, `UNSUPPORTED_VERSION`) | The pass. Only the contract rules reject with 400, and they run last, so reaching one means the token was accepted and the org number resolved to exactly one active company. |
| `401` | The token is not the one the box has. |
| `503` | The box has no delivery configured, or the org number matches no active company or several. The body names which. |

Fetching `GET /svar` by hand does not consume answers: they repeat until
acknowledged. Never send a probe acknowledgement for an answer bertil has not ingested.

### Step 3: bertil's box

In bertil's `.env`:

```
GNUBOK_API_URL=https://bokforing.bohed.com
GNUBOK_API_KEY=<the same value from step 1>
```

Install a client that posts
`{ "transaction_id": "<id>", "answer_id": "<answer_id>" }` (both copied from
the answer it ingested; a body without `answer_id` is rejected with 400) to
`POST /svar/kvittens` after successful durable ingestion (including an
already-ingested no-op). Use the same bearer token. Retry failed acknowledgements;
never acknowledge failed ingestion. Update `fetch_svar`'s docstring to describe
repeat-until-acknowledged delivery. The complete contract is in
`docs/underlagsjakt-export-schema.md`, Transport.

Then schedule the client, so the delivery is nobody's daily chore:

```cron
# /etc/cron.d/underlagsjakt-leverans
#
# System crontab format: field 6 is the user to run as, the command stays on
# one line, and the file must end with a newline or cron ignores the last one.
PATH=/usr/local/bin:/usr/bin:/bin
17 6 * * * deploy cd /opt/projects/bertil && python underlagsjakt_export_client.py >> var/leverans.log 2>&1
```

Replace `deploy` with the user that owns bertil's checkout and reads that
`.env`, and the invocation with however bertil's repository runs the client
(venv, `uv run`, `make`). Point the log at a file that user can already write,
for the reason spelled out in section 5: the shell opens the redirect before
the command runs, so an unwritable path kills the job silently every morning.

### Step 4: prove both directions, once, with real data

Requirement 5 of the task is this step, and it is the one that cannot be
skipped: everything above is configuration, and configuration that has never
carried a real export is not a working delivery.

1. Run the client by hand once: `python underlagsjakt_export_client.py`.
2. Open `https://bokforing.bohed.com/e/general/underlagsjakt` without touching
   a file. The line under the summary must read "Automatisk leverans från
   bertil är påslagen för det här bolaget. Den här exporten kom hit av sig
   själv." If it says "lästes in som fil", the page is still showing an older
   hand-uploaded export and the delivery did not land: check the client's log
   for the status code and look it up in the table in step 2.
3. Answer one question in that surface.
4. Let the client run again (or wait for the 06:17 tick) and confirm the
   answer is in bertil's knowledge base as a learned rule.
5. If ingestion fails, fetch again and verify the same answer is offered.
   After successful ingestion, verify the client's acknowledgement returns 200,
   `levererad_at` is set, and the next fetch omits the answer. Retry a lost
   acknowledgement response and verify it also returns 200. If acknowledgements
   never arrive, the standing check alarms after two days. A question re-exported
   after seven days reopens while its old answer remains available for retries.
6. Run `npx tsx extensions/general/underlagsjakt/leverans-status.ts` on the
   Accounted box once more. **Exit 0 is the pass**, and it is the one the row
   in section 10 comes out for. Anything else names the half that did not
   happen: an export that only ever arrived as a file, a bertil that never
   called `GET /svar`, no recorded acknowledgement, or an overdue unacknowledged answer.

The command is the record. It reads what the two directions actually wrote
(`imported_via` on the stored export, the polling journal, and answer acknowledgement timestamps), so "we did this once in September" cannot survive a delivery that
has since stopped: the same run that proved the chain is the run that keeps
proving it.

Until it exits 0 on real data, treat the chain as unproven and leave the row in
section 10 standing. The first exit 0 is what unlocks step 5, and the row comes
out when that schedule is installed: a chain proved once is not a chain anyone
is still watching.

### Step 5: schedule the standing check on the Accounted box

Do this once step 4 has produced an exit 0, and not before: until then the
check answers 2 by design, and a schedule installed early would alarm every
morning about a switch-on that is simply still in progress.

The check keeps proving the chain only if something runs it. A human who has
to remember a command is the same failure the check exists to catch, one step
further out: the delivery dies, nobody runs the check, and the surface goes
back to saying "import the file" with nobody the wiser. So the check gets a
schedule of its own on this box, next to the sync in section 5:

```cron
# /etc/cron.d/underlagsjakt-status
#
# System crontab format: field 6 is the user to run as, the command stays on
# one line, and the file must end with a newline or cron ignores the last one.
# Daily at 07:13, which is after bertil's 06:17 delivery has had time to land.
# Needs devDependencies installed in the clone (npm install), the same as the
# by-hand run in step 2.
PATH=/usr/local/bin:/usr/bin:/bin
UNDERLAGSJAKT_STATUS_HEARTBEAT_URL=https://hc-ping.com/REPLACE-WITH-YOUR-SECOND-CHECK-UUID
13 7 * * * deploy cd /opt/projects/accounted && npx tsx extensions/general/underlagsjakt/leverans-status.ts >> fork/state/leverans-status.log 2>&1 && curl -fsS --max-time 10 "$UNDERLAGSJAKT_STATUS_HEARTBEAT_URL" >/dev/null
```

Replace `deploy` with the user that owns the clone, use a **second** external
check (not the sync's: a shared one cannot tell you which of the two routines
went quiet), and end the file with a newline. Without a heartbeat check, drop
the `UNDERLAGSJAKT_STATUS_HEARTBEAT_URL` line and the trailing `&& curl ...`
rather than leaving the variable empty, which would make every healthy run end
in a failed `curl`.

The `&&` is the whole alarm: the ping only happens on exit 0, so every way the
delivery can stop reaches you from outside the box. Exit 2 (an export that
stopped arriving, a bertil that stopped collecting, either half quiet for two
days), exit 4 (someone cleared the `.env` on a redeploy), a clone whose
`npm install` was wiped, and a box that is off all look the same to the
external check: no ping. Exit 0 needs both halves to have carried data and
**each** of them to have done so recently, so one working direction cannot keep
the morning ping green over a dead one.
That is the one failure mode nothing running on the box can report about
itself, which is why section 5 uses the same dead-man's switch.

The log goes to `fork/state/leverans-status.log` inside the clone, for the
reason spelled out in section 5: the shell opens the redirect as the cron user
before the command runs, so a `/var/log/...` target that user cannot create
kills the job there every morning without ever running the check. `fork/state/`
is owned by the clone owner and already gitignored. When a ping goes missing,
that log holds the report: it names which of the two directions stopped.

This cron only watches. Nothing on this box can deliver anything, because
bertil serves nothing to pull; the schedule in step 3, on bertil's box, is the
one that carries the export.
