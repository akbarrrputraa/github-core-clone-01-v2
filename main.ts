// Entry point for the github-core-clone-01 server.
//
// The harness drives the whole trial through the environment at
// MAKEFUN_ENV_URL: this process only has to come up, tell the env which
// port it is listening on, and stay alive until the env says the trial
// is finished. Nothing here talks to GitHub or to any model — the forge
// itself lives in app.ts, and this file just wires its lifecycle to the
// env.
//
// The conversation, in order:
//   * read MAKEFUN_ENV_URL (no env, no trial: give up at once);
//   * build the forge with createApp() and bind an ephemeral port — the
//     kernel chooses, never 8080, which belongs to the env;
//   * POST { port } to $MAKEFUN_ENV_URL/register so the env can dial us;
//   * poll GET $MAKEFUN_ENV_URL/done until it reports done: true;
//   * shut the server down and leave with status 0.
//
// Both network steps retry on transient failure with exponential
// backoff, because the env can still be warming up when we first
// knock. A 409 from register only means some entry registered first,
// which is fine; 400/405 mean the request itself is wrong, so there
// is nothing to retry and the process fails fast instead.

import { createApp } from './app.ts';

// Longest a single HTTP round trip may run before we give up on it.
const CALL_BUDGET_MS = 30_000;
// The /done poll is a tiny local read: it never needs the full call budget,
// and a short timeout keeps a stalled env from delaying our exit.
const DONE_POLL_MS = 5_000;
// First pause after a failed attempt, and the ceiling it grows to.
const PAUSE_START_MS = 250;
const PAUSE_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

// Pause before retry number `n` (0-based): doubles each time, capped.
function pauseFor(n: number): number {
  return Math.min(PAUSE_LIMIT_MS, PAUSE_START_MS * 2 ** Math.min(n, 8));
}

// The env origin, with any trailing slashes trimmed off.
function envOrigin(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

// Tell the env where to reach us. Returns once the registration sticks.
// 200 is the ordinary answer; 409 means another entry got there first
// and our port is not needed. 400/405 are contract violations — retrying
// would only repeat the same bad request — so they abort the process.
async function announce(port: number, origin: string): Promise<void> {
  for (let n = 0; ; n += 1) {
    let reply: Response;
    try {
      reply = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
    } catch {
      // The env is not reachable yet: wait and knock again.
      await pause(pauseFor(n));
      continue;
    }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) {
      throw new Error(`register refused: HTTP ${reply.status} ${await reply.text()}`);
    }
    await pause(pauseFor(n));
  }
}

// Keep asking the env whether the trial is over. The env answers every
// poll immediately (done: false while the suite is still running), so
// this is a loop of short requests, never one long-held request. v2 polls
// on a fixed short pause: the old exponential backoff (up to 2 s) only
// delayed our exit after the suite finished, burning wall budget.
async function awaitFinished(origin: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(DONE_POLL_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // A failed or timed-out poll is just a "not done yet".
    }
    await pause(100);
  }
}

async function boot(): Promise<void> {
  const origin = envOrigin();
  if (origin === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to talk to');
  }

  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => resolve());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] forge up on port ${bound.port}\n`);

  await announce(bound.port, origin);
  process.stdout.write('[entry] registered; waiting for the env to finish\n');

  await awaitFinished(origin);
  forge.close();
  process.stdout.write('[entry] done\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
