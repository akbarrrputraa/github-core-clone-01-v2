// The forge store: in-memory repositories, issues, pull requests, labels and
// the git object store, shared by REST, git smart-HTTP, GraphQL and MCP so
// every surface sees the same state.
import { buildCommit, buildTree, hashObject, parseCommit, parseTree } from './gitpack.ts';
import type { CommitData, GitObject, TreeEntry } from './gitpack.ts';
import { SERVER_EPOCH_SEC } from './scenario.ts';
import type { ScenarioIdentity } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  /** Serialized GET /issues/:n body as bytes, cached because the read
   * workload reads one issue thousands of times; cleared on any mutation
   * of the issue. */
  jsonCache?: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  comments: Map<number, IssueComment[]>;
  pulls: PullRequest[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  createdSeq: number;
  /** Bumped on every ref mutation; git response caches are keyed by it, so a
   * push/merge/contents-write can never serve a stale pack or advertisement.
   * Objects only ever arrive together with a ref update (or unreachable),
   * so keying on the ref version is sufficient. */
  gitVersion: number;
  /** Cached git smart-HTTP responses (fetch packs, ls-refs, advertisements)
   * for this repo's current gitVersion. Cleared on bumpGit. */
  fetchCache: Map<string, Buffer>;
  advCache: Map<string, Buffer>;
  /** Memoized parses of this repo's immutable commit/tree objects. */
  commitCache: Map<string, CommitData>;
  treeCache: Map<string, TreeEntry[]>;
}

export class Store {
  repos = new Map<string, Repo>();
  repoIdSeq = 1;
  issueIdSeq = 1;
  commentIdSeq = 1;
  pullIdSeq = 1;
  repoSeq = 1;
  identity: ScenarioIdentity;

  constructor(identity: ScenarioIdentity) {
    this.identity = identity;
  }

  get viewerLogin(): string {
    return this.identity.viewer.login;
  }

  get viewerName(): string {
    return this.identity.viewer.name;
  }

  get viewerEmail(): string {
    return this.identity.viewer.email;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.repoIdSeq,
      owner,
      name,
      isPrivate,
      description: description ?? '',
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      comments: new Map(),
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      createdSeq: this.repoSeq,
      gitVersion: 0,
      fetchCache: new Map(),
      advCache: new Map(),
      commitCache: new Map(),
      treeCache: new Map(),
    };
    this.repoIdSeq += 1;
    this.repoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Invalidate every cached git response for `repo` after a ref mutation. */
  bumpGit(repo: Repo): void {
    repo.gitVersion += 1;
    repo.fetchCache.clear();
    repo.advCache.clear();
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** All commit oids reachable from `tips` (following parents), newest-first by walk order. */
  reachableCommits(repo: Repo, tips: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack = [...tips].reverse();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const commit = commitDataOf(repo, oid);
      if (commit === null) continue;
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
    }
    return out;
  }

  /**
   * Fast-forward check with an early exit: the common case (a push whose
   * old tip is the new commit's direct parent) answers after one pop
   * instead of walking the whole history. Same verdict as the full walk.
   */
  isAncestor(repo: Repo, maybeAncestor: string, tip: string): boolean {
    if (maybeAncestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === maybeAncestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = commitDataOf(repo, oid);
      if (commit === null) continue;
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set(this.reachableCommits(repo, [a]));
    for (const oid of this.reachableCommits(repo, [b])) {
      if (ancestorsA.has(oid)) return oid;
    }
    return null;
  }

  /** Flat map of path -> {mode, oid} for the tree at `treeOid` (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const walk = (oid: string, path: string): void => {
      for (const entry of treeEntriesOf(repo, oid)) {
        const full = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, full);
        else out.set(full, { mode: entry.mode, name: entry.name, oid: entry.oid });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree object from a flat path -> blob oid map, creating intermediate trees. */
  treeFromFlat(repo: Repo, flat: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
        node = node.dirs.get(segments[i]) as Node;
      }
      node.files.set(segments[segments.length - 1], oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `repo` with the viewer's identity and a fixed epoch (deterministic). */
  createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const author = `${this.viewerName} <${this.viewerEmail}>`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      author,
      committer: author,
      timestamp: SERVER_EPOCH_SEC,
    });
    return this.putObject(repo, 'commit', data);
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    return commitDataOf(repo, commitOid)?.tree ?? null;
  }

  /** Resolve a ref name or oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
    if (repo.objects.has(ref)) {
      const obj = repo.objects.get(ref) as GitObject;
      if (obj.type === 'commit') return ref;
      if (obj.type === 'tag') {
        // Peel an annotated tag to its commit.
        const text = obj.data.toString('utf8');
        for (const line of text.split('\n')) {
          if (line.startsWith('object ')) {
            const target = line.slice(7).trim();
            const targetObj = repo.objects.get(target);
            if (targetObj !== undefined && targetObj.type === 'commit') return target;
          }
          if (line === '') break;
        }
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // contents
  // -------------------------------------------------------------------------------------------

  /** The blob oid at `path` on the given commit, or null. */
  blobAtPath(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const treeOid = this.commitTree(repo, commitOid);
    if (treeOid === null) return null;
    const flat = this.flattenTree(repo, treeOid);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const obj = repo.objects.get(entry.oid);
    if (obj === undefined || obj.type !== 'blob') return null;
    return { oid: entry.oid, data: obj.data };
  }

  /** Immediate children of `dir` on the given commit. */
  listDir(repo: Repo, commitOid: string, dir: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> | null {
    const treeOid = this.commitTree(repo, commitOid);
    if (treeOid === null) return null;
    const flat = this.flattenTree(repo, treeOid);
    const prefix = dir === '' ? '' : `${dir}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
      } else {
        const name = rest.slice(0, slash);
        if (!seen.has(name)) {
          // The directory's tree oid: find it by walking the tree.
          const dirOid = this.treeOidAtPath(repo, treeOid, `${prefix}${name}`);
          seen.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: dirOid ?? '' });
        }
      }
    }
    // Include empty subdirectories? A git tree has no empty dirs; only paths
    // reachable from files are listed, which matches git behaviour.
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  treeOidAtPath(repo: Repo, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (const segment of segments) {
      const entry = treeEntriesOf(repo, current).find((e) => e.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return current;
  }

  // -------------------------------------------------------------------------------------------
  // issues / pulls / labels
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `Label "${name}" does not exist` };
      labels.push(label);
    }
    repo.issueSeq += 1;
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.issueSeq,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      seq: repo.issueSeq,
    };
    this.issueIdSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  addComment(repo: Repo, number: number, body: string): IssueComment | null {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return null;
    const comment: IssueComment = { id: this.commentIdSeq, body };
    this.commentIdSeq += 1;
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    issue.jsonCache = undefined;
    return comment;
  }

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (headSha === undefined) return { error: `head ref "${headRef}" does not exist` };
    if (baseSha === undefined) return { error: `base ref "${baseRef}" does not exist` };
    repo.pullSeq += 1;
    const pull: PullRequest = {
      id: this.pullIdSeq,
      number: repo.pullSeq,
      title,
      body: body ?? '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: repo.pullSeq,
    };
    this.pullIdSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The current tip of the pull's base branch (moves as other pulls merge). */
  currentBaseTip(repo: Repo, pull: PullRequest): string {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  /** Files changed between the merge base and the head tip. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const base = this.mergeBase(repo, pull.headSha, this.currentBaseTip(repo, pull)) ?? pull.baseSha;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, pull.headSha);
    if (baseTree === null || headTree === null) return [];
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const inBase = baseFlat.get(path);
      const inHead = headFlat.get(path);
      if (inBase !== undefined && inHead !== undefined && inBase.oid === inHead.oid) continue;
      if (inBase === undefined && inHead !== undefined) {
        const data = repo.objects.get(inHead.oid)?.data ?? Buffer.alloc(0);
        const lines = splitLines(data);
        out.push({ filename: path, status: 'added', additions: lines.length, deletions: 0, changes: lines.length });
      } else if (inBase !== undefined && inHead === undefined) {
        const data = repo.objects.get(inBase.oid)?.data ?? Buffer.alloc(0);
        const lines = splitLines(data);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines.length, changes: lines.length });
      } else if (inBase !== undefined && inHead !== undefined) {
        const oldData = repo.objects.get(inBase.oid)?.data ?? Buffer.alloc(0);
        const newData = repo.objects.get(inHead.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = lineDiff(oldData, newData);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Does merging `pull` conflict with the current base tip? */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const tip = this.currentBaseTip(repo, pull);
    const base = this.mergeBase(repo, pull.headSha, tip);
    if (base === null) return false;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, pull.headSha);
    const tipTree = this.commitTree(repo, tip);
    if (baseTree === null || headTree === null || tipTree === null) return false;
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    const tipFlat = this.flattenTree(repo, tipTree);
    const paths = new Set([...headFlat.keys(), ...tipFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid;
      const h = headFlat.get(path)?.oid;
      const t = tipFlat.get(path)?.oid;
      const headChanged = h !== b;
      const tipChanged = t !== b;
      if (headChanged && tipChanged && h !== t) return true;
    }
    return false;
  }

  mergePull(repo: Repo, pull: PullRequest): { ok: true; sha: string; message: string } | { ok: false; status: number; message: string } {
    if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is already closed' };
    if (this.pullConflicts(repo, pull)) return { ok: false, status: 405, message: 'Merge conflict' };
    const tip = this.currentBaseTip(repo, pull);
    const base = this.mergeBase(repo, pull.headSha, tip) ?? tip;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, pull.headSha);
    const tipTree = this.commitTree(repo, tip);
    if (baseTree === null || headTree === null || tipTree === null) {
      return { ok: false, status: 422, message: 'Cannot merge: missing tree' };
    }
    // Squash: start from the base tip tree, apply the head's changes.
    const result = this.flattenTree(repo, tipTree);
    const baseFlat = this.flattenTree(repo, baseTree);
    const headFlat = this.flattenTree(repo, headTree);
    for (const [path, entry] of headFlat) {
      if (baseFlat.get(path)?.oid !== entry.oid) result.set(path, entry);
    }
    for (const path of baseFlat.keys()) {
      if (!headFlat.has(path)) result.delete(path);
    }
    const flat = new Map<string, string>();
    for (const [path, entry] of result) flat.set(path, entry.oid);
    const treeOid = this.treeFromFlat(repo, flat);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const sha = this.createCommit(repo, treeOid, [tip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    this.bumpGit(repo);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(SERVER_EPOCH_SEC * 1000).toISOString();
    pull.mergeCommitSha = sha;
    return { ok: true, sha, message };
  }

  // -------------------------------------------------------------------------------------------
  // global ids (opaque, stable)
  // -------------------------------------------------------------------------------------------

  globalId(kind: string, key: string): string {
    return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
  }

  repoGlobalId(repo: Repo): string {
    return this.globalId('Repository', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return this.globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
  }

  commentGlobalId(repo: Repo, number: number, comment: IssueComment): string {
    return this.globalId('IssueComment', `${repo.owner}/${repo.name}#${number}:${comment.id}`);
  }

  decodeGlobalId(id: string): { kind: string; key: string } | null {
    try {
      const decoded = Buffer.from(id, 'base64url').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon < 0) return null;
      return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
    } catch {
      return null;
    }
  }
}

/**
 * Memoized commit parse for one repo's immutable objects: the push workload
 * walks the same ancestors on every push, and re-parsing each commit's bytes
 * on every walk is quadratic. A cache miss parses once; objects are never
 * mutated after they are stored, so a cached parse stays valid.
 */
export function commitDataOf(repo: Repo, oid: string): CommitData | null {
  const hit = repo.commitCache.get(oid);
  if (hit !== undefined) return hit;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

/** Memoized tree parse, same reasoning as commitDataOf. */
export function treeEntriesOf(repo: Repo, oid: string): TreeEntry[] {
  const hit = repo.treeCache.get(oid);
  if (hit !== undefined) return hit;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tree') return [];
  const parsed = parseTree(obj.data);
  repo.treeCache.set(oid, parsed);
  return parsed;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line difference: lines added in `next`, lines removed from `prev`. */
function lineDiff(prev: Buffer, next: Buffer): { additions: number; deletions: number } {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldCounts = count(splitLines(prev));
  const newCounts = count(splitLines(next));
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCounts) {
    const old = oldCounts.get(line) ?? 0;
    if (n > old) additions += n - old;
  }
  for (const [line, n] of oldCounts) {
    const next = newCounts.get(line) ?? 0;
    if (n > next) deletions += n - next;
  }
  return { additions, deletions };
}
