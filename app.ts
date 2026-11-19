// The forge HTTP server: health probe, GitHub REST v3, GraphQL, MCP and git
// smart-HTTP, all on one in-memory store. main.ts owns the lifecycle; this
// file owns the routes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { scenarioIdentity } from './scenario.ts';
import { Store } from './store.ts';
import * as rest from './rest.ts';
import type { RequestInfo } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

const JSON_TYPE = 'application/json';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => {
    // Most segments are plain ASCII; only decode when percent-encoded.
    if (!s.includes('%')) return s;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7).trim() !== '';
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store(scenarioIdentity());
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `forge-${(requestCounter += 1).toString(16).padStart(8, '0')}`;
    const commonHeaders: Record<string, string> = { 'x-github-request-id': requestId };

    void (async () => {
      try {
        // Parse the path without a URL object: the hot REST paths carry no
        // query string, and a URL parse is the most expensive step here.
        const rawUrl = req.url ?? '/';
        const qmark = rawUrl.indexOf('?');
        const path = qmark === -1 ? rawUrl : rawUrl.slice(0, qmark);
        const method = req.method ?? 'GET';
        // The origin/query pair is only needed by list endpoints (pagination
        // links) and info/refs; build it lazily so the hot paths skip both
        // the template string and the URLSearchParams parse.
        let infoCache: RequestInfo | null = null;
        const getInfo = (): RequestInfo => {
          if (infoCache === null) {
            infoCache = {
              origin: `http://${req.headers.host ?? '127.0.0.1'}`,
              query: qmark === -1 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(qmark + 1)),
            };
          }
          return infoCache;
        };

        // Health probe: no auth, always 200.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, commonHeaders);
          return;
        }

        const needsAuth = path.startsWith('/api/') || path === '/mcp';
        if (needsAuth && !isAuthed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, commonHeaders);
          return;
        }

        const isGitPath = /\.git\//.test(path);
        // GETs carry no body in this suite; skip the stream drain for them
        // (but still drain if a body was actually sent).
        const hasBody = req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0';
        const rawBody = method === 'GET' && !hasBody ? Buffer.alloc(0) : await readBody(req);
        const isJsonPath = !isGitPath;

        // Parse a JSON body where one is expected.
        let jsonBody: unknown = undefined;
        let jsonParseFailed = false;
        if (isJsonPath && rawBody.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
          try {
            jsonBody = JSON.parse(rawBody.toString('utf8'));
          } catch {
            jsonParseFailed = true;
          }
        }
        if (jsonParseFailed) {
          if (path === '/mcp') {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, commonHeaders);
          } else {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, commonHeaders);
          }
          return;
        }
        const bodyObj = (jsonBody ?? {}) as Record<string, unknown>;

        // ---- MCP ----
        if (path === '/mcp' && method === 'POST') {
          if (jsonBody === null || typeof jsonBody !== 'object') {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, commonHeaders);
            return;
          }
          const outcome = handleMcpRequest(store, jsonBody as Record<string, unknown>);
          if (outcome === null) {
            // A notification: no reply body.
            res.writeHead(202, { ...commonHeaders, 'mcp-session-id': 'forge-session' });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.body, { ...commonHeaders, ...(outcome.headers ?? {}) });
          return;
        }

        // ---- GraphQL ----
        if (path === '/api/graphql' && method === 'POST') {
          const operations = Array.isArray(jsonBody) ? jsonBody : [jsonBody];
          const results = operations.map((op) => {
            const operation = (op ?? {}) as Record<string, unknown>;
            const query = operation.query as string | undefined;
            const variables = (operation.variables ?? {}) as Record<string, unknown>;
            if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
            const { data, errors } = executeGraphQL(store, query, variables);
            return errors.length > 0 ? { data, errors } : { data };
          });
          sendJson(res, 200, Array.isArray(jsonBody) ? results : results[0], commonHeaders);
          return;
        }

        // ---- API root / meta / user ----
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, rest.handleRoot(store).body, { ...commonHeaders, 'x-oauth-scopes': 'repo, read:org' });
          return;
        }
        if (method === 'GET' && path === '/api/v3/meta') {
          sendJson(res, 200, rest.handleMeta().body, commonHeaders);
          return;
        }
        if (method === 'GET' && path === '/api/v3/user') {
          sendJson(res, 200, rest.handleUser(store).body, commonHeaders);
          return;
        }
        if (path === '/api/v3/user/repos') {
          if (method === 'POST') {
            const out = rest.handleCreateRepo(store, bodyObj);
            sendJson(res, out.status, out.body, { ...commonHeaders, ...(out.headers ?? {}) });
            return;
          }
          if (method === 'GET') {
            const out = rest.handleListRepos(store, getInfo());
            sendJson(res, out.status, out.body, { ...commonHeaders, ...(out.headers ?? {}) });
            return;
          }
        }

        // ---- hot lanes: the timed read/write workloads hit these two routes
        // thousands of times. They bypass segmentsOf() and the dispatch
        // chain below; anything unusual (a query string, a percent-encoded
        // segment, a non-integer number) falls through to the generic path,
        // which keeps the exact same verdicts.
        if (qmark === -1 && path.startsWith('/api/v3/repos/')) {
          const parts = path.split('/');
          if (parts.length === 8 && parts[6] === 'issues' && method === 'GET' && !parts[4].includes('%') && !parts[5].includes('%')) {
            const n = Number(parts[7]);
            if (Number.isInteger(n) && n > 0) {
              const repo = store.getRepo(parts[4], parts[5]);
              if (repo === undefined) {
                sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
                return;
              }
              const issue = store.getIssue(repo, n);
              if (issue === undefined) {
                sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
                return;
              }
              const body = rest.cachedIssueBody(store, repo, issue);
              res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': body.length, 'x-github-request-id': requestId });
              res.end(body);
              return;
            }
          }
          if (parts.length === 7 && parts[6] === 'issues' && method === 'POST' && !parts[4].includes('%') && !parts[5].includes('%')) {
            const out = rest.handleCreateIssue(store, parts[4], parts[5], bodyObj);
            sendJson(res, out.status, out.body, commonHeaders);
            return;
          }
        }

        // ---- /api/v3/repos/:owner/:name/... ----
        const segs = segmentsOf(path);
        if (segs.length >= 4 && segs[0] === 'api' && segs[1] === 'v3' && segs[2] === 'repos') {
          const owner = segs[3];
          const name = segs[4];
          const tail = segs.slice(5);
          const answer = (out: { status: number; body: unknown; headers?: Record<string, string>; rawBody?: string }): void => {
            if (out.status === 204) {
              res.writeHead(204, { ...commonHeaders, ...(out.headers ?? {}) });
              res.end();
              return;
            }
            if (out.rawBody !== undefined) {
              const buf = Buffer.isBuffer(out.rawBody) ? out.rawBody : Buffer.from(out.rawBody, 'utf8');
              res.writeHead(out.status, { 'content-type': JSON_TYPE, 'content-length': buf.length, ...commonHeaders, ...(out.headers ?? {}) });
              res.end(buf);
              return;
            }
            sendJson(res, out.status, out.body, { ...commonHeaders, ...(out.headers ?? {}) });
          };
          if (tail.length === 0) {
            if (method === 'GET') return answer(rest.handleGetRepo(store, owner, name));
            if (method === 'PATCH') return answer(rest.handlePatchRepo(store, owner, name, bodyObj));
            if (method === 'DELETE') return answer(rest.handleDeleteRepo(store, owner, name));
          } else if (tail[0] === 'branches' && tail.length === 1) {
            if (method === 'GET') return answer(rest.handleListBranches(store, owner, name));
          } else if (tail[0] === 'branches' && tail.length === 2) {
            if (method === 'GET') return answer(rest.handleGetBranch(store, owner, name, tail[1]));
          } else if (tail[0] === 'commits' && tail.length === 1) {
            if (method === 'GET') return answer(rest.handleListCommits(store, owner, name, getInfo()));
          } else if (tail[0] === 'contents') {
            const contentPath = tail.slice(1).join('/');
            if (method === 'GET') return answer(rest.handleGetContents(store, owner, name, contentPath, getInfo()));
            if (method === 'PUT') return answer(rest.handlePutContents(store, owner, name, contentPath, bodyObj));
            if (method === 'DELETE') return answer(rest.handleDeleteContents(store, owner, name, contentPath, bodyObj));
          } else if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
            if (method === 'POST') return answer(rest.handleCreateRef(store, owner, name, bodyObj));
            if (method === 'GET') return answer(rest.handleListRefs(store, owner, name));
          } else if (tail[0] === 'git' && tail[1] === 'refs' && tail.length > 2) {
            if (method === 'GET') return answer(rest.handleGetRef(store, owner, name, tail.slice(2).join('/')));
          } else if (tail[0] === 'labels' && tail.length === 1) {
            if (method === 'POST') return answer(rest.handleCreateLabel(store, owner, name, bodyObj));
            if (method === 'GET') return answer(rest.handleListLabels(store, owner, name));
          } else if (tail[0] === 'issues' && tail.length === 1) {
            if (method === 'POST') return answer(rest.handleCreateIssue(store, owner, name, bodyObj));
            if (method === 'GET') return answer(rest.handleListIssues(store, owner, name, getInfo()));
          } else if (tail[0] === 'issues' && tail.length === 2) {
            const number = Number(tail[1]);
            if (Number.isInteger(number)) {
              if (method === 'GET') return answer(rest.handleGetIssue(store, owner, name, number));
              if (method === 'PATCH') return answer(rest.handlePatchIssue(store, owner, name, number, bodyObj));
            }
          } else if (tail[0] === 'issues' && tail.length === 3 && tail[2] === 'comments') {
            const number = Number(tail[1]);
            if (Number.isInteger(number)) {
              if (method === 'POST') return answer(rest.handleCreateComment(store, owner, name, number, bodyObj));
              if (method === 'GET') return answer(rest.handleListComments(store, owner, name, number));
            }
          } else if (tail[0] === 'pulls' && tail.length === 1) {
            if (method === 'POST') return answer(rest.handleCreatePull(store, owner, name, bodyObj));
            if (method === 'GET') return answer(rest.handleListPulls(store, owner, name, getInfo()));
          } else if (tail[0] === 'pulls' && tail.length === 2) {
            const number = Number(tail[1]);
            if (Number.isInteger(number) && method === 'GET') return answer(rest.handleGetPull(store, owner, name, number));
          } else if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'files') {
            const number = Number(tail[1]);
            if (Number.isInteger(number) && method === 'GET') return answer(rest.handleListPullFiles(store, owner, name, number));
          } else if (tail[0] === 'pulls' && tail.length === 3 && tail[2] === 'merge') {
            const number = Number(tail[1]);
            if (Number.isInteger(number) && method === 'PUT') return answer(rest.handleMergePull(store, owner, name, number, bodyObj));
          }
          sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
          return;
        }

        // ---- git smart-HTTP ----
        if (isGitPath) {
          const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
          if (gitMatch !== null) {
            const owner = decodeURIComponent(gitMatch[1]);
            const name = decodeURIComponent(gitMatch[2]);
            const service = gitMatch[3];
            const gitProtocol = req.headers['git-protocol'] ?? null;
            if (method === 'GET' && service === 'info/refs') {
              const out = handleInfoRefs(store, owner, name, getInfo().query.get('service') ?? '', gitProtocol);
              sendBuffer(res, out.status, out.body, out.contentType, commonHeaders);
              return;
            }
            if (method === 'POST' && service === 'git-upload-pack') {
              const out = handleUploadPack(store, owner, name, rawBody, gitProtocol);
              sendBuffer(res, out.status, out.body, out.contentType, commonHeaders);
              return;
            }
            if (method === 'POST' && service === 'git-receive-pack') {
              const out = handleReceivePack(store, owner, name, rawBody);
              sendBuffer(res, out.status, out.body, out.contentType, commonHeaders);
              return;
            }
          }
          sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
          return;
        }

        // ---- unknown route ----
        sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
      } catch (error) {
        process.stderr.write(`[entry] request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal server error' }, commonHeaders);
        else res.end();
      }
    })();
  });

  // The timed workloads are sequential request/response ping-pong on one
  // connection; Nagle + delayed ACK can stall each round trip, so disable
  // Nagle on every socket. Keep-alive stays at the Node default.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
