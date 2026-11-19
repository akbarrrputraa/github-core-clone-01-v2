// MCP (Model Context Protocol) over Streamable HTTP at POST /mcp.
// Modern era (2026-07-28): server/discover + initialize both answered.
// JSON-RPC 2.0; unknown tools -> -32601; missing args -> isError:true;
// non-JSON bodies -> HTTP 400 with -32700 (handled in app.ts).
import { repoJson, issueJson, pullJson } from './rest.ts';
import type { Store } from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export function mcpTools(): McpToolDef[] {
  return TOOLS;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve a possibly-aliased argument name to its canonical value. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function missingRequired(tool: McpToolDef, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') missing.push(required);
  }
  return missing;
}

export function callMcpTool(store: Store, name: string, args: Record<string, unknown>): { result: ToolResult } | { error: { code: number; message: string } } {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  const missing = missingRequired(tool, args);
  if (missing.length > 0) return { result: errorResult(`Missing required argument(s): ${missing.join(', ')}`) };

  if (name === 'create_repo') {
    const repoName = String(arg(args, 'name') ?? '');
    const owner = typeof arg(args, 'owner') === 'string' && (arg(args, 'owner') as string) !== '' ? String(arg(args, 'owner')) : store.viewerLogin;
    const repo = store.createRepo(owner, repoName, arg(args, 'private') === true, typeof arg(args, 'description') === 'string' ? String(arg(args, 'description')) : '');
    if (repo === null) return { result: errorResult(`Repository ${owner}/${repoName} already exists`) };
    const json = repoJson(repo) as Record<string, unknown>;
    return { result: textResult(JSON.stringify(json), json) };
  }

  if (name === 'get_repo') {
    const owner = String(arg(args, 'owner', 'owner_login', 'login') ?? '');
    const repoName = String(arg(args, 'repo', 'repository', 'repo_name') ?? '');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { result: errorResult(`Repository ${owner}/${repoName} not found`) };
    const json = repoJson(repo) as Record<string, unknown>;
    return { result: textResult(JSON.stringify(json), json) };
  }

  if (name === 'create_issue') {
    const owner = String(arg(args, 'owner', 'owner_login', 'login') ?? '');
    const repoName = String(arg(args, 'repo', 'repository', 'repo_name') ?? '');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { result: errorResult(`Repository ${owner}/${repoName} not found`) };
    const result = store.createIssue(repo, String(arg(args, 'title') ?? ''), typeof arg(args, 'body', 'description', 'content', 'text') === 'string' ? String(arg(args, 'body', 'description', 'content', 'text')) : '', []);
    if ('error' in result) return { result: errorResult(result.error) };
    const json = issueJson(store, repo, result) as Record<string, unknown>;
    return { result: textResult(JSON.stringify(json), json) };
  }

  if (name === 'list_issues') {
    const owner = String(arg(args, 'owner', 'owner_login', 'login') ?? '');
    const repoName = String(arg(args, 'repo', 'repository', 'repo_name') ?? '');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { result: errorResult(`Repository ${owner}/${repoName} not found`) };
    const state = typeof arg(args, 'state') === 'string' ? String(arg(args, 'state')) : 'open';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => a.seq - b.seq);
    const list = issues.map((issue) => issueJson(store, repo, issue));
    return { result: textResult(JSON.stringify(list), { issues: list }) };
  }

  if (name === 'create_pull_request') {
    const owner = String(arg(args, 'owner', 'owner_login', 'login') ?? '');
    const repoName = String(arg(args, 'repo', 'repository', 'repo_name') ?? '');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { result: errorResult(`Repository ${owner}/${repoName} not found`) };
    const head = String(arg(args, 'head', 'head_ref', 'source_branch', 'from') ?? '');
    const base = String(arg(args, 'base', 'base_ref', 'target') ?? '');
    const result = store.createPull(repo, head, base, String(arg(args, 'title') ?? ''), typeof arg(args, 'body', 'description', 'content', 'text') === 'string' ? String(arg(args, 'body', 'description', 'content', 'text')) : '');
    if ('error' in result) return { result: errorResult(result.error) };
    const json = pullJson(store, repo, result) as Record<string, unknown>;
    return { result: textResult(JSON.stringify(json), json) };
  }

  if (name === 'merge_pull_request') {
    const owner = String(arg(args, 'owner', 'owner_login', 'login') ?? '');
    const repoName = String(arg(args, 'repo', 'repository', 'repo_name') ?? '');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return { result: errorResult(`Repository ${owner}/${repoName} not found`) };
    const number = Number(arg(args, 'pull_number', 'pr_number', 'number') ?? NaN);
    if (!Number.isInteger(number)) return { result: errorResult('pull_number is required') };
    const pull = store.getPull(repo, number);
    if (pull === undefined) return { result: errorResult(`Pull request #${number} not found`) };
    const merged = store.mergePull(repo, pull);
    if (!merged.ok) return { result: errorResult(merged.message) };
    const json = { number: pull.number, merged: true, state: 'closed', sha: merged.sha };
    return { result: textResult(JSON.stringify(json), json) };
  }

  return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

export interface McpOutcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Handle one parsed JSON-RPC request object. Returns null for notifications. */
export function handleMcpRequest(store: Store, request: Record<string, unknown>): McpOutcome | null {
  const id = (request.id as string | number | null | undefined) ?? null;
  const method = request.method as string | undefined;
  const params = (request.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): McpOutcome => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
    headers: { 'mcp-session-id': 'forge-session' },
  });
  const rpcError = (code: number, message: string, status = 200): McpOutcome => ({
    status,
    body: { jsonrpc: '2.0', id, error: { code, message } },
    headers: { 'mcp-session-id': 'forge-session' },
  });

  if (typeof method !== 'string') return rpcError(-32600, 'Invalid Request');

  if (method === 'server/discover') {
    return result({
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }

  if (method === 'initialize') {
    const declared = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const protocolVersion = declared !== null && SUPPORTED_VERSIONS.includes(declared) ? declared : SUPPORTED_VERSIONS[0];
    return result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id and expects no reply.
    return null;
  }

  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof toolName !== 'string' || toolName === '') return rpcError(-32602, 'Tool name is required');
    const outcome = callMcpTool(store, toolName, args);
    if ('error' in outcome) return rpcError(outcome.error.code, outcome.error.message);
    return result(outcome.result);
  }

  if (method === 'ping') {
    return result({});
  }

  return rpcError(-32601, `Method not found: ${method}`);
}
