// REST API (GitHub v3 shape) handlers. Every reply is JSON; errors carry
// {message: string}; pagination uses Link rel="next" with absolute URLs.
import { hashObject } from './gitpack.ts';
import type { Issue, Label, PullRequest, Repo } from './store.ts';
import type { Store } from './store.ts';
import { SERVER_EPOCH_SEC } from './scenario.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Pre-serialized JSON body (including the trailing newline sendJson
   * would add); when set, the caller sends it as-is. A Buffer is sent
   * without copying; a string is encoded once. */
  rawBody?: string | Buffer;
}

export interface RequestInfo {
  origin: string;
  query: URLSearchParams;
}

const FIXED_ISO = new Date(SERVER_EPOCH_SEC * 1000).toISOString();

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '', default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

/** Serialized single-issue body as bytes, cached on the issue (see store.ts). */
export function cachedIssueBody(store: Store, repo: Repo, issue: Issue): Buffer {
  if (issue.jsonCache === undefined) issue.jsonCache = Buffer.from(`${JSON.stringify(issueJson(store, repo, issue))}\n`, 'utf8');
  return issue.jsonCache;
}

export function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: 1000, type: 'User' },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: 1000, type: 'User' },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const parseIdent = (line: string): { name: string; email: string; date: string } => {
    const m = line.match(/^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/);
    if (m === null) return { name: line, email: '', date: FIXED_ISO };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const authorIdent = parseIdent(author);
  const committerIdent = parseIdent(committer);
  // The stored object ends the message with a newline; the API presents it
  // without the trailing newline, as GitHub does.
  const presentedMessage = message.replace(/\n+$/, '');
  return {
    sha: oid,
    commit: {
      message: presentedMessage,
      author: authorIdent,
      committer: committerIdent,
    },
    author: { login: store.viewerLogin },
    committer: { login: store.viewerLogin },
    parents: parents.map((sha) => ({ sha })),
  };
}

/** Paginate `items` per the query; returns the page and a Link header value (or ''). */
export function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, origin: string): { page: T[]; link: string } {
  const rawPerPage = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, Math.floor(rawPerPage))) : 30;
  const rawPage = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `${origin}${path}?${q.toString()}`;
  };
  if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page, link: links.join(', ') };
}

function notFoundRepo(): RestResponse {
  return err(404, 'Not Found');
}

function getRepoOr404(store: Store, owner: string, name: string): { repo: Repo } | { response: RestResponse } {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { response: notFoundRepo() };
  return { repo };
}

// ---------------------------------------------------------------------------------------------
// /api/v3 root
// ---------------------------------------------------------------------------------------------

export function handleRoot(store: Store): RestResponse {
  return ok(200, {
    current_user_url: '/api/v3/user',
    rate_limit_url: '/api/v3/rate_limit',
    repository_url: '/api/v3/repos/{owner}/{repo}',
  });
}

export function handleMeta(): RestResponse {
  return ok(200, { installed_version: '1.0.0' });
}

export function handleUser(store: Store): RestResponse {
  return ok(200, {
    login: store.viewerLogin,
    id: 1000,
    name: store.viewerName,
    email: store.viewerEmail,
    type: 'User',
  });
}

// ---------------------------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------------------------

export function handleCreateRepo(store: Store, body: Record<string, unknown>): RestResponse {
  const name = body.name;
  if (typeof name !== 'string' || name === '') return err(422, 'name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Invalid repository name');
  const repo = store.createRepo(store.viewerLogin, name, body.private === true, typeof body.description === 'string' ? body.description : '');
  if (repo === null) return err(422, 'name already exists on this account');
  return ok(201, repoJson(repo));
}

export function handleListRepos(store: Store, info: RequestInfo): RestResponse {
  const repos = store.listRepos();
  const { page, link } = paginate(repos, info.query, '/api/v3/user/repos', info.origin);
  return ok(200, page.map(repoJson), link === '' ? undefined : { link });
}

export function handleGetRepo(store: Store, owner: string, name: string): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  return ok(200, repoJson(found.repo));
}

export function handlePatchRepo(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  if (typeof body.description === 'string') found.repo.description = body.description;
  if (typeof body.private === 'boolean') found.repo.isPrivate = body.private;
  return ok(200, repoJson(found.repo));
}

export function handleDeleteRepo(store: Store, owner: string, name: string): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  store.deleteRepo(owner, name);
  return { status: 204, body: null };
}

export function handleListBranches(store: Store, owner: string, name: string): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const branches = [...found.repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .sort()
    .map((ref) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: found.repo.refs.get(ref) as string },
      protected: false,
    }));
  return ok(200, branches);
}

export function handleGetBranch(store: Store, owner: string, name: string, branch: string): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const sha = found.repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return err(404, 'Branch not found');
  return ok(200, { name: branch, commit: { sha }, protected: false });
}

export function handleListCommits(store: Store, owner: string, name: string, info: RequestInfo): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const ref = info.query.get('sha');
  const tip = ref === null ? found.repo.refs.get(`refs/heads/${found.repo.defaultBranch}`) : store.resolveRef(found.repo, ref);
  if (tip === undefined) return err(404, 'Not Found');
  const commits = store.reachableCommits(found.repo, [tip]);
  const out: Array<Record<string, unknown>> = [];
  for (const oid of commits) {
    const json = commitJson(store, found.repo, oid);
    if (json !== null) out.push(json);
  }
  const { page, link } = paginate(out, info.query, `/api/v3/repos/${owner}/${name}/commits`, info.origin);
  return ok(200, page, link === '' ? undefined : { link });
}

// ---------------------------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------------------------

export function handleCreateRef(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const ref = body.ref;
  const sha = body.sha;
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'sha is required');
  if (found.repo.refs.has(ref)) return err(422, 'Reference already exists');
  const obj = found.repo.objects.get(sha);
  if (obj === undefined) return err(422, 'Object does not exist');
  found.repo.refs.set(ref, sha);
  store.bumpGit(found.repo);
  return ok(201, { ref, object: { sha, type: obj.type }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}` });
}

export function handleGetRef(store: Store, owner: string, name: string, ref: string): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const sha = found.repo.refs.get(ref);
  if (sha === undefined) return err(404, 'Not Found');
  const obj = found.repo.objects.get(sha);
  return ok(200, { ref, object: { sha, type: obj?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}` });
}

export function handleListRefs(store: Store, owner: string, name: string): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const refs = [...found.repo.refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ref, sha]) => ({ ref, object: { sha, type: found.repo.objects.get(sha)?.type ?? 'commit' } }));
  return ok(200, refs);
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

export function handleGetContents(store: Store, owner: string, name: string, path: string, info: RequestInfo): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const repo = found.repo;
  const ref = info.query.get('ref');
  const tip = ref === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : store.resolveRef(repo, ref);
  if (tip === undefined) return err(404, 'Not Found');
  const decoded = decodeURIComponent(path);
  if (decoded === '') {
    const entries = store.listDir(repo, tip, '');
    if (entries === null) return err(404, 'Not Found');
    return ok(200, entries.map((e) => ({ ...e, url: `/api/v3/repos/${owner}/${name}/contents/${e.path}` })));
  }
  const file = store.blobAtPath(repo, tip, decoded);
  if (file !== null) {
    const segments = decoded.split('/');
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: file.data.length,
      name: segments[segments.length - 1],
      path: decoded,
      content: file.data.toString('base64'),
      sha: file.oid,
      url: `/api/v3/repos/${owner}/${name}/contents/${decoded}`,
      html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${decoded}`,
      git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${file.oid}`,
      download_url: `https://example.invalid/${owner}/${name}/raw/${repo.defaultBranch}/${decoded}`,
    });
  }
  const entries = store.listDir(repo, tip, decoded);
  if (entries === null) return err(404, 'Not Found');
  // A path that is neither a file nor a directory with entries is missing.
  if (entries.length === 0) return err(404, 'Not Found');
  return ok(200, entries.map((e) => ({ ...e, url: `/api/v3/repos/${owner}/${name}/contents/${e.path}` })));
}

export function handlePutContents(store: Store, owner: string, name: string, path: string, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const repo = found.repo;
  const decoded = decodeURIComponent(path);
  if (decoded === '') return err(422, 'path is required');
  if (typeof body.message !== 'string' || body.message === '') return err(422, 'message is required');
  if (typeof body.content !== 'string') return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(body.content, 'base64');
    if (content.toString('base64').replace(/=+$/, '') !== body.content.replace(/=+$/, '')) return err(422, 'content is not valid base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branch}`);
  const isNewBranch = tip === undefined;
  if (isNewBranch) {
    // Unborn repo (first commit) or a branch that does not exist yet: start
    // from the default branch tip when there is one, else an empty tree.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const baseTree = tip === undefined ? null : store.commitTree(repo, tip);
  const flatEntries = baseTree === null ? new Map<string, string>() : new Map([...store.flattenTree(repo, baseTree).entries()].map(([p, e]) => [p, e.oid] as [string, string]));
  const flat = flatEntries;
  const existing = flat.get(decoded);
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing !== undefined && givenSha === undefined) return err(422, '"sha" wasn\'t supplied');
  if (existing !== undefined && givenSha !== undefined && givenSha !== existing) {
    return err(409, 'sha does not match the current blob');
  }
  const blobOid = store.putObject(repo, 'blob', content);
  flat.set(decoded, blobOid);
  const treeOid = store.treeFromFlat(repo, flat);
  const message = body.message as string;
  const commitOid = store.createCommit(repo, treeOid, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  store.bumpGit(repo);
  const status = existing === undefined ? 201 : 200;
  const segments = decoded.split('/');
  return ok(status, {
    content: {
      name: segments[segments.length - 1],
      path: decoded,
      sha: blobOid,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      url: `/api/v3/repos/${owner}/${name}/contents/${decoded}`,
    },
    commit: { sha: commitOid, message },
  });
}

export function handleDeleteContents(store: Store, owner: string, name: string, path: string, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const repo = found.repo;
  const decoded = decodeURIComponent(path);
  if (typeof body.message !== 'string' || body.message === '') return err(422, 'message is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return err(404, 'Not Found');
  const treeOid = store.commitTree(repo, tip);
  if (treeOid === null) return err(404, 'Not Found');
  const flat = store.flattenTree(repo, treeOid);
  const existing = flat.get(decoded);
  if (existing === undefined) return err(404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha !== existing.oid) return err(409, 'sha does not match the current blob');
  flat.delete(decoded);
  const newTreeOid = store.treeFromFlat(repo, new Map([...flat.entries()].map(([p, e]) => [p, e.oid] as [string, string])));
  const commitOid = store.createCommit(repo, newTreeOid, [tip], body.message as string);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  store.bumpGit(repo);
  return ok(200, { commit: { sha: commitOid, message: body.message }, content: null });
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

export function handleCreateLabel(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  if (typeof body.name !== 'string' || body.name === '') return err(422, 'name is required');
  if (found.repo.labels.has(body.name)) return err(422, 'Label already exists');
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  const label: Label = { name: body.name, color };
  found.repo.labels.set(body.name, label);
  return ok(201, labelJson(label));
}

export function handleListLabels(store: Store, owner: string, name: string): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  return ok(200, [...found.repo.labels.values()].map(labelJson));
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

export function handleCreateIssue(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  if (typeof body.title !== 'string' || body.title === '') return err(422, 'title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  const result = store.createIssue(found.repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
  if ('error' in result) return err(422, result.error);
  return ok(201, issueJson(store, found.repo, result));
}

export function handleListIssues(store: Store, owner: string, name: string, info: RequestInfo): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const state = info.query.get('state') ?? 'open';
  const sort = info.query.get('sort') ?? 'created';
  const direction = info.query.get('direction') ?? 'desc';
  let issues = [...found.repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, link } = paginate(issues, info.query, `/api/v3/repos/${owner}/${name}/issues`, info.origin);
  return ok(200, page.map((issue) => issueJson(store, found.repo, issue)), link === '' ? undefined : { link });
}

export function handleGetIssue(store: Store, owner: string, name: string, number: number): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const issue = store.getIssue(found.repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  return { status: 200, body: null, rawBody: cachedIssueBody(store, found.repo, issue) };
}

export function handlePatchIssue(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const issue = store.getIssue(found.repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  if (typeof body.state === 'string') {
    if (body.state !== 'open' && body.state !== 'closed') return err(422, 'state must be open or closed');
    issue.state = body.state;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  issue.jsonCache = undefined;
  return ok(200, issueJson(store, found.repo, issue));
}

export function handleCreateComment(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  if (typeof body.body !== 'string' || body.body === '') return err(422, 'body is required');
  const comment = store.addComment(found.repo, number, body.body);
  if (comment === null) return err(404, 'Not Found');
  return ok(201, {
    id: comment.id,
    body: comment.body,
    user: { login: store.viewerLogin, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${owner}/${name}/issues/${number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
  });
}

export function handleListComments(store: Store, owner: string, name: string, number: number): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const issue = store.getIssue(found.repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  const comments = found.repo.comments.get(number) ?? [];
  return ok(200, comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    user: { login: store.viewerLogin, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${owner}/${name}/issues/${number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
  })));
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

export function handleCreatePull(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  if (typeof body.head !== 'string' || typeof body.base !== 'string') return err(422, 'head and base are required');
  if (typeof body.title !== 'string' || body.title === '') return err(422, 'title is required');
  const result = store.createPull(found.repo, body.head, body.base, body.title, typeof body.body === 'string' ? body.body : '');
  if ('error' in result) return err(422, result.error);
  return ok(201, pullJson(store, found.repo, result));
}

export function handleListPulls(store: Store, owner: string, name: string, info: RequestInfo): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const state = info.query.get('state') ?? 'open';
  let pulls = [...found.repo.pulls];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => a.seq - b.seq);
  const { page, link } = paginate(pulls, info.query, `/api/v3/repos/${owner}/${name}/pulls`, info.origin);
  return ok(200, page.map((pull) => pullJson(store, found.repo, pull)), link === '' ? undefined : { link });
}

export function handleGetPull(store: Store, owner: string, name: string, number: number): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const pull = store.getPull(found.repo, number);
  if (pull === undefined) return err(404, 'Not Found');
  return ok(200, pullJson(store, found.repo, pull));
}

export function handleListPullFiles(store: Store, owner: string, name: string, number: number): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const pull = store.getPull(found.repo, number);
  if (pull === undefined) return err(404, 'Not Found');
  return ok(200, store.pullFiles(found.repo, pull));
}

export function handleMergePull(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResponse {
  const found = getRepoOr404(store, owner, name);
  if ('response' in found) return found.response;
  const pull = store.getPull(found.repo, number);
  if (pull === undefined) return err(404, 'Not Found');
  const result = store.mergePull(found.repo, pull);
  if (!result.ok) return err(result.status, result.message);
  return ok(200, { sha: result.sha, merged: true, message: result.message });
}

// Keep hashObject referenced for future content-addressed helpers.
void hashObject;
