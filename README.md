# github-core-clone-01-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/akbarrrputraa/github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/akbarrrputraa/github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge v2: git smart-HTTP (v2/v0), REST v3, GraphQL and MCP over one in-memory store — cached packs, memoized git walks, fast REST lanes

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zm2jvf0q&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What v2 changes vs v1

v1 graded 989/1000 locally yet only 922 on the server (rank 5,271/9,132) with
feature 600/600 and agent 200/200 — the whole gap was perf (122/200). The
server runs the same trial on a slower, shared pod, so v2 attacks the four
timed workloads directly:

- **Clone**: fetch/ls-refs/advertisement responses are cached per repo and
  keyed by the ref version, so 50 concurrent shallow clones of one head build
  the pack once. Any ref move (push, merge, contents write, ref create)
  bumps the version and clears the caches.
- **Push**: the fast-forward check exits as soon as the old tip is found
  (one step when it is the new commit's direct parent) instead of walking the
  whole history, and commit/tree parses are memoized per repo, so the push
  chain stops being quadratic. Pack reading finds each zlib stream's end
  with a native `Buffer.indexOf` Adler-32 search instead of a JS byte loop,
  and object hashing no longer copies the object bytes.
- **Read/write**: the two timed REST routes take fast lanes that skip the
  generic router, build the origin/query lazily, and serve the issue body
  from a cached `Buffer`. Sockets get `setNoDelay(true)` for the sequential
  request/response ping-pong, and the entrypoint polls `/done` on a fixed
  short pause so the trial exits promptly.

Local verification (kit `grade-local`, `--driver process`): 120/120 checks on
all three practice instances, replay matched byte-for-byte on all three, and
v2 beats v1 in every paired same-load A/B run (push −16…−31%, read −7…−22%,
clone −4…−38%).

## Layout

- `main.ts` — the entry <-> env lifecycle (bind ephemeral port, register,
  poll `/done`, exit 0).
- `app.ts` — the HTTP server: routing, auth, request ids, body handling,
  fast lanes for the timed REST routes.
- `store.ts` — the forge state: repos, issues, pull requests, labels, the
  git object store, tree/diff/merge logic, opaque global ids, memoized
  commit/tree parses.
- `gitpack.ts` — SHA-1 objects, pkt-lines, pack read/write (with OFS/REF
  delta resolution), tree/commit/tag build and parse.
- `git.ts` — git smart-HTTP: v2/v0 advertisements, ls-refs, fetch
  (shallow/deepen/incremental), receive-pack with report-status, and the
  per-repo response caches.
- `rest.ts` — the REST v3 handlers (repos, branches, commits, contents,
  refs, labels, issues, comments, pulls).
- `graphql.ts` — a small GraphQL parser and executor for the gh-style
  documents the suite sends.
- `mcp.ts` — MCP: server/discover, initialize, tools/list and the six
  tools (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request).
- `scenario.ts` — the scenario identity generator (viewer `adaiversen`,
  stranger `olgabauer`, org `faint-meadow-org`), ported verbatim from the
  kit and verified against the kit's own `buildScenario()`.

## Notes

- Server-created commits use a fixed epoch, so state is deterministic
  across replays.
- Authentication: any non-empty Bearer token is accepted on `/api/*` and
  `/mcp`; a missing token is 401. Git smart-HTTP and `/healthz` take no
  auth, matching the clients.
- The viewer identity is computed from the scenario seed, so every check
  that compares logins, owners and commit author emails sees the same
  values the kit generates.
