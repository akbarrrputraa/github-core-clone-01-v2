// Scenario identity: a verbatim port of the kit's scenario generator for the
// identity values only (viewer / teammate / stranger logins, org). The checks
// compare every owner/login/email against these values, so they must match the
// kit's buildScenario() exactly. Verified byte-for-byte against the kit:
// viewer adaiversen, teammate quinnkeller, stranger olgabauer, org faint-meadow-org.
export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const SERVER_EPOCH_SEC = 1_700_000_000;

const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const m = seed & U64_MASK;
    this.#state = m === 0n ? SCENARIO_SEED : m;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % maxExclusive;
    }
  }
  pick(items: readonly string[]): string {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas',
  'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess',
  'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen',
  'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi',
  'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly',
  'keen', 'lively', 'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft',
  'steady', 'tidy', 'upbeat', 'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon',
  'glade', 'harbor', 'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid',
  'pebble', 'quartz', 'raven', 'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

export interface ScenarioIdentity {
  viewer: ScenarioUser;
  teammate: ScenarioUser;
  stranger: ScenarioUser;
  org: string;
}

export function scenarioIdentity(): ScenarioIdentity {
  const users = generateUsers(new Rng(scenarioSeedFor('users')), 12);
  const orgRng = new Rng(scenarioSeedFor('org'));
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  return { viewer: users[0], teammate: users[1], stranger: users[2], org };
}
