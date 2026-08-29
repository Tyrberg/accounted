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

- **The fork has no commits of its own.** Catching up is therefore a
  fast-forward, not a merge. There is no conflict resolution to do and nothing
  to document as "broken on the way", because no two versions of any file ever
  had to be reconciled.
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
| Migration inventory 2026-05-11 to now    | 370 files, see section 3.                                        |

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
| 2026-07                      | 168             |
| 2026-08                      | 0               |
| **Total from 2026-05-11**    | **370**         |
| Total in `supabase/migrations/` | 546          |

First in the window: `20260511120000_bank_connections_pending_selection.sql`.
Last in the window: `20260730090000_kpi_monthly_exclude_year_end.sql`.

Regenerate this inventory at any time with:

```bash
ls supabase/migrations | awk '$0 >= "20260511"' | wc -l
ls supabase/migrations | awk '$0 >= "20260511"' | cut -c1-6 | sort | uniq -c
```

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
the same 370-file jump plus interest and there is no supported path that
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

There are zero tier 2 patches today. That is the target state, not an accident.

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
   If that fails, something has been committed to `main` that should not have
   been. Find it before going further; do not make a merge commit to get past it.
4. **Reinstall and re-verify.** `npm ci`, then `npm test`, `npm run check:lint`,
   `npm run check:guards`.
5. **Check the adaptations.** `npx tsx fork/cli.ts sync`. Exit 2 means an
   adaptation broke, and the report names it, says what changed upstream, and
   quotes the reason recorded in the manifest.
6. **Rebase tier 2, if any exists.** `git rebase upstream/main fork/patches`,
   then re-run step 5. Drop any patch whose upstream PR has been merged, and
   delete its manifest entry in the same commit.
7. **Do the database.** Section 3. Backup restore, scratch database,
   `npm run test:pg`, then live.
8. **Push and deploy.** `git push origin main`, then the deployment's own
   procedure ([docs/SELF-HOSTING.md](../docs/SELF-HOSTING.md)).

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
| The 370-migration schema jump, if any environment is still on the old schema | Follows from q657-1  |
| Revoke and remove the GitLab `glpat-` token       | Whoever has GitLab admin, per section 9       |
| Archive the GitLab project as read-only           | Same                                          |
