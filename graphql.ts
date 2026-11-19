// GraphQL executor for the fixed document set the suite sends (gh-style
// queries/mutations over /api/graphql). A small spec-shaped parser plus a
// typed resolver map; unknown fields produce a 200 with an errors array.
import type { Issue, PullRequest, Repo } from './store.ts';
import type { Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  arguments: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string | null;
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: string[];
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  tokens: Token[];
  pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
    }
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') {
          name = this.next().value as string;
        }
        const variableDefinitions = this.parseVariableDefinitions();
        const selections = this.parseSelectionSet();
        operations.push({ operation, name, variableDefinitions, selections });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)}`);
      }
    }
    return { operations, fragments };
  }

  parseVariableDefinitions(): string[] {
    const names: string[] = [];
    if (!this.matchPunct('(')) return names;
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unexpected end in variable definitions');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return names;
      }
      this.expectPunct('$');
      names.push(this.expectName());
      this.expectPunct(':');
      this.parseType();
      if (this.matchPunct('=')) this.parseValue();
    }
  }

  parseType(): void {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unexpected end in selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', name: null, typeCondition, selections };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = this.next().value as string;
        return { kind: 'fragment', name, typeCondition: null, selections: [] };
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', name: null, typeCondition: null, selections };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    if (this.matchPunct(':')) {
      alias = name;
      fieldName = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.matchPunct('(')) {
      while (true) {
        const t = this.peek();
        if (t === undefined) throw new Error('unexpected end in arguments');
        if (t.kind === 'punct' && t.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: SelectionNode[] = [];
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name: fieldName, alias, arguments: args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (true) {
        const t = this.peek();
        if (t === undefined) throw new Error('unexpected end in list');
        if (t.kind === 'punct' && t.value === ']') {
          this.next();
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (true) {
        const t = this.peek();
        if (t === undefined) throw new Error('unexpected end in object');
        if (t.kind === 'punct' && t.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

export function parseDocument(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// value resolution
// ---------------------------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.arguments) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

interface ExecutorContext {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
}

type FieldResolver = (
  parent: GqlObject,
  args: Record<string, unknown>,
  ctx: ExecutorContext,
  field: FieldNode,
) => unknown;

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION', 'WIKI', 'PACKAGE', 'MARKETPLACE', 'ORGANIZATION', 'MILESTONE'],
};

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoObject(store: Store, repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: store.repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueObject(store: Store, repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: store.issueGlobalId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
  };
}

function pullObject(store: Store, repo: Repo, pull: PullRequest): GqlObject {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: store.pullGlobalId(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
  };
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqFromCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = decoded.match(/^cursor:(\d+)$/);
    if (m !== null) return Number(m[1]);
  } catch {
    // fall through
  }
  return 0;
}

function issueConnection(store: Store, repo: Repo, issues: Issue[], first: number | undefined, after: string | null | undefined): GqlObject {
  const afterSeq = seqFromCursor(after);
  const filtered = issues.filter((issue) => issue.seq > afterSeq);
  const page = first === undefined ? filtered : filtered.slice(0, first);
  const last = page[page.length - 1];
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(store, repo, issue)),
    edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueObject(store, repo, issue), cursor: cursorFor(issue.seq) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: first !== undefined && filtered.length > first,
      hasPreviousPage: afterSeq > 0,
      startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
      endCursor: last !== undefined ? cursorFor(last.seq) : null,
    },
    totalCount: issues.length,
  };
}

function pullConnection(store: Store, repo: Repo, pulls: PullRequest[], first: number | undefined): GqlObject {
  const page = first === undefined ? pulls : pulls.slice(0, first);
  const last = page[page.length - 1];
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(store, repo, pull)),
    edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullObject(store, repo, pull), cursor: cursorFor(pull.seq) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: first !== undefined && pulls.length > first,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(page[0].seq) : null,
      endCursor: last !== undefined ? cursorFor(last.seq) : null,
    },
    totalCount: pulls.length,
  };
}

const RESOLVERS: Record<string, Record<string, FieldResolver>> = {
  Query: {
    viewer: (parent, _args, ctx) => ({
      __typename: 'User',
      login: ctx.store.viewerLogin,
      id: 'user:1000',
      name: ctx.store.viewerName,
      email: ctx.store.viewerEmail,
    }),
    repository: (parent, args, ctx) => {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return repoObject(ctx.store, repo);
    },
    node: (parent, args, ctx) => {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      const decoded = ctx.store.decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const [owner, name] = decoded.key.split('/');
        const repo = ctx.store.getRepo(owner, name);
        if (repo === undefined) return null;
        return repoObject(ctx.store, repo);
      }
      if (decoded.kind === 'Issue') {
        const hash = decoded.key.indexOf('#');
        if (hash < 0) return null;
        const [owner, name] = decoded.key.slice(0, hash).split('/');
        const number = Number(decoded.key.slice(hash + 1));
        const repo = ctx.store.getRepo(owner, name);
        if (repo === undefined) return null;
        const issue = ctx.store.getIssue(repo, number);
        if (issue === undefined) return null;
        return issueObject(ctx.store, repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const hash = decoded.key.indexOf('#');
        if (hash < 0) return null;
        const [owner, name] = decoded.key.slice(0, hash).split('/');
        const number = Number(decoded.key.slice(hash + 1));
        const repo = ctx.store.getRepo(owner, name);
        if (repo === undefined) return null;
        const pull = ctx.store.getPull(repo, number);
        if (pull === undefined) return null;
        return pullObject(ctx.store, repo, pull);
      }
      return null;
    },
    __type: (parent, args, ctx) => {
      const name = args.name as string | undefined;
      if (typeof name !== 'string') return null;
      if (TYPE_FIELDS[name] === undefined && TYPE_ENUM_VALUES[name] === undefined) return null;
      return {
        __typename: '__Type',
        name,
        kind: TYPE_ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT',
        __fields: TYPE_FIELDS[name] ?? [],
        __enumValues: TYPE_ENUM_VALUES[name] ?? [],
      };
    },
  },
  Mutation: {
    createIssue: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repositoryId = input.repositoryId as string | undefined;
      if (typeof repositoryId !== 'string') return { __typename: 'CreateIssuePayload', issue: null };
      const decoded = ctx.store.decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') return { __typename: 'CreateIssuePayload', issue: null };
      const [owner, name] = decoded.key.split('/');
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return { __typename: 'CreateIssuePayload', issue: null };
      const result = ctx.store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      if ('error' in result) return { __typename: 'CreateIssuePayload', issue: null };
      return { __typename: 'CreateIssuePayload', issue: issueObject(ctx.store, repo, result) };
    },
    closeIssue: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const issueId = input.issueId as string | undefined;
      if (typeof issueId !== 'string') return { __typename: 'CloseIssuePayload', issue: null };
      const decoded = ctx.store.decodeGlobalId(issueId);
      if (decoded === null || decoded.kind !== 'Issue') return { __typename: 'CloseIssuePayload', issue: null };
      const hash = decoded.key.indexOf('#');
      if (hash < 0) return { __typename: 'CloseIssuePayload', issue: null };
      const [owner, name] = decoded.key.slice(0, hash).split('/');
      const number = Number(decoded.key.slice(hash + 1));
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return { __typename: 'CloseIssuePayload', issue: null };
      const issue = ctx.store.getIssue(repo, number);
      if (issue === undefined) return { __typename: 'CloseIssuePayload', issue: null };
      issue.state = 'closed';
      issue.jsonCache = undefined;
      return { __typename: 'CloseIssuePayload', issue: issueObject(ctx.store, repo, issue) };
    },
    createPullRequest: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repositoryId = input.repositoryId as string | undefined;
      if (typeof repositoryId !== 'string') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const decoded = ctx.store.decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const [owner, name] = decoded.key.split('/');
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const result = ctx.store.createPull(
        repo,
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
      );
      if ('error' in result) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(ctx.store, repo, result) };
    },
    mergePullRequest: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const pullRequestId = input.pullRequestId as string | undefined;
      if (typeof pullRequestId !== 'string') return { __typename: 'MergePullRequestPayload', pullRequest: null };
      const decoded = ctx.store.decodeGlobalId(pullRequestId);
      if (decoded === null || decoded.kind !== 'PullRequest') return { __typename: 'MergePullRequestPayload', pullRequest: null };
      const hash = decoded.key.indexOf('#');
      if (hash < 0) return { __typename: 'MergePullRequestPayload', pullRequest: null };
      const [owner, name] = decoded.key.slice(0, hash).split('/');
      const number = Number(decoded.key.slice(hash + 1));
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return { __typename: 'MergePullRequestPayload', pullRequest: null };
      const pull = ctx.store.getPull(repo, number);
      if (pull === undefined) return { __typename: 'MergePullRequestPayload', pullRequest: null };
      ctx.store.mergePull(repo, pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(ctx.store, repo, pull) };
    },
    addComment: (parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = input.subjectId as string | undefined;
      const body = typeof input.body === 'string' ? input.body : '';
      if (typeof subjectId !== 'string') return { __typename: 'AddCommentPayload', commentEdge: null };
      const decoded = ctx.store.decodeGlobalId(subjectId);
      if (decoded === null || decoded.kind !== 'Issue') return { __typename: 'AddCommentPayload', commentEdge: null };
      const hash = decoded.key.indexOf('#');
      if (hash < 0) return { __typename: 'AddCommentPayload', commentEdge: null };
      const [owner, name] = decoded.key.slice(0, hash).split('/');
      const number = Number(decoded.key.slice(hash + 1));
      const repo = ctx.store.getRepo(owner, name);
      if (repo === undefined) return { __typename: 'AddCommentPayload', commentEdge: null };
      const comment = ctx.store.addComment(repo, number, body);
      if (comment === null) return { __typename: 'AddCommentPayload', commentEdge: null };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: ctx.store.commentGlobalId(repo, number, comment),
            body: comment.body,
          },
        },
      };
    },
  },
  Repository: {
    issue: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = ctx.store.getIssue(repo, number);
      if (issue === undefined) return null;
      return issueObject(ctx.store, repo, issue);
    },
    issues: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      let issues = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy !== undefined && orderBy.field === 'CREATED_AT') {
        issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
      } else {
        issues.sort((a, b) => a.seq - b.seq);
      }
      const first = typeof args.first === 'number' ? args.first : undefined;
      const after = (args.after as string | null | undefined) ?? null;
      return issueConnection(ctx.store, repo, issues, first, after);
    },
    pullRequests: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const pulls = [...repo.pulls].sort((a, b) => a.seq - b.seq);
      const first = typeof args.first === 'number' ? args.first : undefined;
      return pullConnection(ctx.store, repo, pulls, first);
    },
    pullRequest: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = ctx.store.getPull(repo, number);
      if (pull === undefined) return null;
      return pullObject(ctx.store, repo, pull);
    },
  },
  PullRequest: {
    files: (parent, args, ctx) => {
      const repo = parent.__repo as Repo;
      const pull = parent.__pull as PullRequest;
      const files = ctx.store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : undefined;
      const page = first === undefined ? files : files.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
        edges: page.map((file) => ({ __typename: 'PullRequestChangedFileEdge', node: { __typename: 'PullRequestChangedFile', path: file.filename } })),
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: first !== undefined && files.length > first,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        totalCount: files.length,
      };
    },
  },
  __Type: {
    fields: (parent, args) => {
      const fields = (parent.__fields as string[] | undefined) ?? [];
      return fields.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (parent, args) => {
      const values = (parent.__enumValues as string[] | undefined) ?? [];
      return values.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
};

function resolveField(parent: GqlObject, field: FieldNode, ctx: ExecutorContext): unknown {
  const typename = parent.__typename;
  const resolvers = RESOLVERS[typename];
  const resolver = resolvers?.[field.name];
  if (resolver !== undefined) {
    const args = resolveArgs(field, ctx.variables);
    return resolver(parent, args, ctx, field);
  }
  // Plain scalar property on the object itself.
  if (Object.prototype.hasOwnProperty.call(parent, field.name)) {
    return parent[field.name];
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
  return null;
}

function resolveSelections(selections: SelectionNode[], parent: GqlObject, ctx: ExecutorContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      let fragmentSelections = selection.selections;
      if (selection.name !== null) {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment === undefined) continue;
        fragmentSelections = fragment.selections;
        if (fragment.typeCondition !== null && fragment.typeCondition !== parent.__typename) continue;
      } else if (selection.typeCondition !== null && selection.typeCondition !== parent.__typename) {
        continue;
      }
      Object.assign(out, resolveSelections(fragmentSelections, parent, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(parent, selection, ctx);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          return resolveSelections(selection.selections, item as GqlObject, ctx);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[key] = resolveSelections(selection.selections, value as GqlObject, ctx);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function executeGraphQL(
  store: Store,
  source: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const document = parseDocument(source);
  const operation = document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document.' }] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const ctx: ExecutorContext = { store, errors: [], fragments: document.fragments, variables };
  const root: GqlObject = { __typename: rootType };
  const data = resolveSelections(operation.selections, root, ctx);
  return { data, errors: ctx.errors };
}
