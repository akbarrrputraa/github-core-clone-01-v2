// Git smart-HTTP: protocol v2/v0 advertisements, ls-refs, fetch (v2 and v0),
// and receive-pack (push) with report-status over sideband.
import {
  ZERO_OID,
  decodePktLines,
  emptyPack,
  flushPkt,
  hashObject,
  parseCommit,
  parseTagTarget,
  pktLine,
  readPack,
  sidebandPack,
  writePack,
} from './gitpack.ts';
import type { GitObject, Repo } from './store.ts';
import type { Store } from './store.ts';
import { commitDataOf } from './store.ts';

export interface GitResponse {
  status: number;
  body: Buffer;
  contentType: string;
}

const AGENT = 'forge/1.0';

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceLine = `# service=${service}\n`;
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=forge/1.0'
      : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(serviceLine), flushPkt()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const main = repo.refs.get('refs/heads/main') ?? refs[0].oid;
    parts.push(pktLine(`${main} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target !== null) parts.push(pktLine(`${target} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** The v2 advertisement never changes: one shared buffer for every request. */
const V2_ADVERTISEMENT: Buffer = (() => {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    flushPkt(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    flushPkt(),
  ];
  return Buffer.concat(parts);
})();

/** Bounded cache put: keeps the newest 64 entries per repo. */
function cachePut(cache: Map<string, Buffer>, key: string, value: Buffer): void {
  if (cache.size >= 64) cache.clear();
  cache.set(key, value);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  name: string,
  service: string,
  gitProtocol: string | null,
): GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    return { status: 404, body: buf(JSON.stringify({ message: 'Not Found' })), contentType: 'application/json' };
  }
  if (service === 'git-receive-pack') {
    // Receive-pack is v0-only: the Git-Protocol header is ignored here.
    const cacheKey = `recv:${repo.gitVersion}`;
    const cached = repo.advCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 200, body: cached, contentType: 'application/x-git-receive-pack-advertisement' };
    }
    const body = v0Advertisement(repo, 'git-receive-pack');
    cachePut(repo.advCache, cacheKey, body);
    return { status: 200, body, contentType: 'application/x-git-receive-pack-advertisement' };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2' || gitProtocol === '2') {
      return { status: 200, body: v2Advertisement(), contentType: 'application/x-git-upload-pack-advertisement' };
    }
    const cacheKey = `up:${repo.gitVersion}`;
    const cached = repo.advCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-advertisement' };
    }
    const body = v0Advertisement(repo, 'git-upload-pack');
    cachePut(repo.advCache, cacheKey, body);
    return { status: 200, body, contentType: 'application/x-git-upload-pack-advertisement' };
  }
  return { status: 404, body: buf(JSON.stringify({ message: 'Not Found' })), contentType: 'application/json' };
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target === null) return null;
      current = target;
      continue;
    }
    return null;
  }
  return null;
}

/** All objects reachable from a commit (the commit, its tree closure). */
function reachableObjects(repo: Repo, commitOid: string, out: Map<string, GitObject>): void {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined) return;
  if (!out.has(commitOid)) out.set(commitOid, commit);
  if (commit.type !== 'commit') return;
  const treeOid = parseCommit(commit.data).tree;
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'tree') {
      const text = obj.data;
      let offset = 0;
      while (offset < text.length) {
        const space = text.indexOf(0x20, offset);
        const nul = text.indexOf(0x00, space);
        if (space < 0 || nul < 0) break;
        stack.push(text.subarray(nul + 1, nul + 21).toString('hex'));
        offset = nul + 21;
      }
    }
  }
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  deepen: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);
  // Have-closure: ancestors of haves, stopping at shallow boundaries (the
  // client holds the boundary commit but not its history).
  const haveClosure = new Set<string>();
  const haveStack = [...haves];
  while (haveStack.length > 0) {
    const oid = haveStack.pop() as string;
    if (haveClosure.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    haveClosure.add(oid);
    if (shallowSet.has(oid)) continue;
    const commit = commitDataOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) haveStack.push(parent);
  }
  const haveObjects = new Map<string, GitObject>();
  for (const oid of haveClosure) reachableObjects(repo, oid, haveObjects);

  // Walk from the wants (peeling tags), generation by generation. The queue
  // is index-driven, not shift()-driven: shift() is O(n) per pop.
  const walkGen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  let queueHead = 0;
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null && !walkGen.has(commit)) {
      walkGen.set(commit, 1);
      queue.push({ oid: commit, gen: 1 });
    }
  }
  while (queueHead < queue.length) {
    const { oid, gen } = queue[queueHead] as { oid: string; gen: number };
    queueHead += 1;
    if (deepen !== null && gen >= deepen) continue;
    const commit = commitDataOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!walkGen.has(parent)) {
        walkGen.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }

  // Objects: everything reachable from the walk, minus what the client holds,
  // plus the want objects themselves (e.g. annotated tags).
  const sendObjects = new Map<string, GitObject>();
  for (const oid of walkGen.keys()) reachableObjects(repo, oid, sendObjects);
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && !sendObjects.has(want)) sendObjects.set(want, obj);
  }
  for (const oid of haveObjects.keys()) sendObjects.delete(oid);

  // Shallow: walk commits whose parent is genuinely unavailable (not in the
  // walk and not held by the client). Unshallow: client boundaries that are
  // now fully included.
  const shallow: string[] = [];
  for (const [oid] of walkGen) {
    const commit = commitDataOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!walkGen.has(parent) && !haveClosure.has(parent)) {
        shallow.push(oid);
        break;
      }
    }
  }
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (!walkGen.has(boundary)) continue;
    const commit = commitDataOf(repo, boundary);
    if (commit === null) continue;
    if (commit.parents.every((parent) => walkGen.has(parent))) unshallow.push(boundary);
  }
  const acks = haves.filter((have) => repo.objects.has(have));
  return { objects: [...sendObjects.values()], shallow, unshallow, acks };
}

// ---------------------------------------------------------------------------------------------
// v2 upload-pack
// ---------------------------------------------------------------------------------------------

function v2FetchResponse(plan: FetchPlan, haves: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(flushPkt());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(flushPkt());
  }
  parts.push(pktLine('packfile\n'));
  const pack = plan.objects.length > 0 ? writePack(plan.objects) : emptyPack();
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

function handleUploadPackV2(repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (error) {
    return { status: 400, body: buf(JSON.stringify({ message: `malformed request: ${(error as Error).message}` })), contentType: 'application/json' };
  }
  const lines = packets
    .filter((p): p is { kind: 'data'; payload: Buffer; raw: Buffer } => p.kind === 'data')
    .map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs') {
    const peel = lines.includes('peel');
    const symrefs = lines.includes('symrefs');
    const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length));
    const cacheKey = `ls-refs:${repo.gitVersion}:${peel ? 1 : 0}:${symrefs ? 1 : 0}:${prefixes.join(',')}`;
    const cached = repo.fetchCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-result' };
    }
    const out: Buffer[] = [];
    const refs = sortedRefs(repo);
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (refs.length > 0) {
      const mainOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
      if (matches('HEAD')) {
        const headLine = symrefs ? `${mainOid} HEAD symref-target:refs/heads/main` : `${mainOid} HEAD`;
        out.push(pktLine(`${headLine}\n`));
      }
      for (const ref of refs) {
        if (!matches(ref.name)) continue;
        let line = `${ref.oid} ${ref.name}`;
        const obj = repo.objects.get(ref.oid);
        if (peel && obj !== undefined && obj.type === 'tag') {
          const target = parseTagTarget(obj.data);
          if (target !== null) line += ` peeled:${target}`;
        }
        out.push(pktLine(`${line}\n`));
      }
    }
    out.push(flushPkt());
    const body = Buffer.concat(out);
    cachePut(repo.fetchCache, cacheKey, body);
    return { status: 200, body, contentType: 'application/x-git-upload-pack-result' };
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let deepen: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
    }
    const cacheKey = `fetch:v2:${repo.gitVersion}:${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${deepen ?? ''}`;
    const cached = repo.fetchCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-result' };
    }
    const plan = planFetch(repo, wants, haves, shallow, deepen);
    const body = v2FetchResponse(plan, haves);
    cachePut(repo.fetchCache, cacheKey, body);
    return { status: 200, body, contentType: 'application/x-git-upload-pack-result' };
  }
  return { status: 400, body: buf(JSON.stringify({ message: `unknown v2 command ${JSON.stringify(command)}` })), contentType: 'application/json' };
}

// ---------------------------------------------------------------------------------------------
// v0 upload-pack
// ---------------------------------------------------------------------------------------------

function handleUploadPackV0(repo: Repo, body: Buffer): GitResponse {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (error) {
    return { status: 400, body: buf(JSON.stringify({ message: `malformed request: ${(error as Error).message}` })), contentType: 'application/json' };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenFlush) {
      if (line.startsWith('want ')) {
        wants.push(line.slice(5).split(' ')[0]);
        const deepenMatch = line.match(/deepen (\d+)/);
        if (deepenMatch !== null) deepen = Number(deepenMatch[1]);
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
    }
  }
  const cacheKey = `fetch:v0:${repo.gitVersion}:${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${deepen ?? ''}`;
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-result' };
  }
  const plan = planFetch(repo, wants, haves, shallow, deepen);
  const parts: Buffer[] = [];
  if (haves.length === 0) parts.push(pktLine('NAK\n'));
  else if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = plan.objects.length > 0 ? writePack(plan.objects) : emptyPack();
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(flushPkt());
  const response = Buffer.concat(parts);
  cachePut(repo.fetchCache, cacheKey, response);
  return { status: 200, body: response, contentType: 'application/x-git-upload-pack-result' };
}

export function handleUploadPack(store: Store, owner: string, name: string, body: Buffer, gitProtocol: string | null): GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    return { status: 404, body: buf(JSON.stringify({ message: 'Not Found' })), contentType: 'application/json' };
  }
  if (gitProtocol === 'version=2' || gitProtocol === '2') return handleUploadPackV2(repo, body);
  return handleUploadPackV0(repo, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    return { status: 404, body: buf(JSON.stringify({ message: 'Not Found' })), contentType: 'application/json' };
  }
  // Split the pkt-line command stream (up to the first flush) from the pack.
  let flushEnd = -1;
  let offset = 0;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      flushEnd = offset + 4;
      break;
    }
    if (len < 4 || offset + len > body.length) break;
    offset += len;
  }
  if (flushEnd < 0) {
    return { status: 400, body: buf(JSON.stringify({ message: 'malformed receive-pack request' })), contentType: 'application/json' };
  }
  let commands: Array<{ oldOid: string; newOid: string; ref: string }>;
  try {
    const packets = decodePktLines(body.subarray(0, flushEnd));
    commands = packets
      .filter((p): p is { kind: 'data'; payload: Buffer; raw: Buffer } => p.kind === 'data')
      .map((p) => {
        const text = p.payload.toString('utf8').replace(/\n$/, '');
        const nul = text.indexOf('\0');
        const clean = nul >= 0 ? text.slice(0, nul) : text;
        const parts = clean.split(' ');
        if (parts.length !== 3) throw new Error('bad command line');
        return { oldOid: parts[0], newOid: parts[1], ref: parts[2] };
      });
  } catch (error) {
    return { status: 400, body: buf(JSON.stringify({ message: `malformed request: ${(error as Error).message}` })), contentType: 'application/json' };
  }
  const packBytes = body.subarray(flushEnd);
  const hasPack = packBytes.length > 0;
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (hasPack) {
    try {
      const parsed = readPack(packBytes);
      for (const [oid, obj] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = `error: ${(error as Error).message}`;
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}`);
  } else {
    reportLines.push('unpack ok');
    let refChanged = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} no such ref`);
        } else if (current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
        } else {
          repo.refs.delete(command.ref);
          refChanged = true;
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists`);
        } else if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} invalid object`);
        } else {
          repo.refs.set(command.ref, command.newOid);
          refChanged = true;
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      // Update.
      if (current === undefined || current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} invalid object`);
      } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        refChanged = true;
        reportLines.push(`ok ${command.ref}`);
      }
    }
    // Any ref move invalidates the cached packs and advertisements.
    if (refChanged) store.bumpGit(repo);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), flushPkt()]);
  const outer = Buffer.concat([...sidebandPack(inner), flushPkt()]);
  return { status: 200, body: outer, contentType: 'application/x-git-receive-pack-result' };
}

// Keep hashObject referenced for callers that build objects from hashes.
void hashObject;
