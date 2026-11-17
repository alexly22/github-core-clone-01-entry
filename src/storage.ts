// In-memory storage for the git forge

import { createHash } from 'node:crypto';
import type {
  GitObject,
  TreeEntry,
  CommitData,
  Ref,
  Repository,
  User,
  Issue,
  Label,
  PullRequest,
  GitRef,
  Commit,
  Tree,
  Blob,
  ContentItem,
  PushResult,
} from './types.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// Global counters
let nextRepoId = 1;
let nextUserId = 1;
let nextIssueId = 1;
let nextLabelId = 1;
let nextPrId = 1;
let nextBlobId = 1;

// Current authenticated user (from token)
let currentUser: User | null = null;

// Storage maps
const repositories = new Map<string, Repository>(); // key: full_name (owner/repo)
const repoData = new Map<string, RepoData>(); // key: full_name
const users = new Map<number, User>();
const usersByLogin = new Map<string, User>();

interface RepoData {
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // ref name -> oid
  issues: Map<number, Issue>;
  labels: Map<string, Label>;
  pullRequests: Map<number, PullRequest>;
  commits: Map<string, Commit>;
}

// Initialize with a default user (the token owner)
function initDefaultUser(): User {
  const user: User = {
    id: nextUserId++,
    login: 'testuser',
    name: 'Test User',
    email: 'test@example.com',
    avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
    html_url: 'https://github.com/testuser',
    type: 'User',
  };
  users.set(user.id, user);
  usersByLogin.set(user.login, user);
  currentUser = user;
  return user;
}

initDefaultUser();

function getCurrentUser(): User {
  if (!currentUser) {
    return initDefaultUser();
  }
  return currentUser;
}

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: GitObject['type'], data: Buffer): string {
  const header = `${type} ${data.length}\0`;
  return sha1(Buffer.concat([Buffer.from(header), data]));
}

function encodeTree(entries: TreeEntry[]): Buffer {
  // Sort entries by name (Git tree order)
  const sorted = [...entries].sort((a, b) => {
    const aName = a.mode.startsWith('100') ? a.name : a.name + '/';
    const bName = b.mode.startsWith('100') ? b.name : b.name + '/';
    return aName.localeCompare(bName);
  });
  
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode;
    const oidBuffer = Buffer.from(entry.oid, 'hex');
    parts.push(Buffer.from(`${mode} ${entry.name}\0`));
    parts.push(oidBuffer);
  }
  return Buffer.concat(parts);
}

function parseCommitData(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  const commit: Partial<CommitData> = { parents: [] };
  let messageStart = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') { messageStart = i + 1; break; }
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents!.push(line.slice(7));
    else if (line.startsWith('author ')) {
      const match = line.match(/author (.+) <(.+)> (\d+) [+-]\d+/);
      if (match) commit.author = { name: match[1], email: match[2], timestamp: parseInt(match[3]) };
    }
    else if (line.startsWith('committer ')) {
      const match = line.match(/committer (.+) <(.+)> (\d+) [+-]\d+/);
      if (match) commit.committer = { name: match[1], email: match[2], timestamp: parseInt(match[3]) };
    }
  }
  
  commit.message = lines.slice(messageStart).join('\n').trim();
  return commit as CommitData;
}

function formatCommit(data: CommitData): Buffer {
  const lines = [
    `tree ${data.tree}`,
    ...data.parents.map(p => `parent ${p}`),
    `author ${data.author.name} <${data.author.email}> ${data.author.timestamp} +0000`,
    `committer ${data.committer.name} <${data.committer.email}> ${data.committer.timestamp} +0000`,
    '',
    data.message,
    '',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// Repository storage functions
function getRepoData(fullName: string): RepoData | undefined {
  return repoData.get(fullName);
}

function createRepoData(fullName: string): RepoData {
  const data: RepoData = {
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    labels: new Map(),
    pullRequests: new Map(),
    commits: new Map(),
  };
  // Initialize with default branch ref
  data.refs.set('refs/heads/main', '0000000000000000000000000000000000000000');
  repoData.set(fullName, data);
  return data;
}

function getOrCreateRepoData(fullName: string): RepoData {
  return getRepoData(fullName) ?? createRepoData(fullName);
}

// Git object storage
function storeObject(repoData: RepoData, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repoData.objects.has(oid)) {
    repoData.objects.set(oid, { type, data, oid });
  }
  return oid;
}

function getObject(repoData: RepoData, oid: string): GitObject | undefined {
  return repoData.objects.get(oid);
}

function getRef(repoData: RepoData, ref: string): string | undefined {
  return repoData.refs.get(ref);
}

function setRef(repoData: RepoData, ref: string, oid: string): void {
  repoData.refs.set(ref, oid);
}

function deleteRef(repoData: RepoData, ref: string): boolean {
  return repoData.refs.delete(ref);
}

function listRefs(repoData: RepoData): Map<string, string> {
  return new Map(repoData.refs);
}

// Repository CRUD
function createRepository(owner: User, name: string, description: string | null, private_: boolean): Repository {
  const fullName = `${owner.login}/${name}`;
  const now = new Date().toISOString();
  const repo: Repository = {
    id: nextRepoId++,
    name,
    full_name: fullName,
    owner,
    private: private_,
    description,
    default_branch: 'main',
    created_at: now,
    updated_at: now,
    pushed_at: null,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    git_url: `git://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
  };
  repositories.set(fullName, repo);
  createRepoData(fullName);
  return repo;
}

function getRepository(fullName: string): Repository | undefined {
  return repositories.get(fullName);
}

function updateRepository(fullName: string, updates: Partial<Repository>): Repository | undefined {
  const repo = repositories.get(fullName);
  if (!repo) return undefined;
  const updated = { ...repo, ...updates, updated_at: new Date().toISOString() };
  repositories.set(fullName, updated);
  return updated;
}

function deleteRepository(fullName: string): boolean {
  repoData.delete(fullName);
  return repositories.delete(fullName);
}

function listUserRepositories(ownerLogin: string): Repository[] {
  const result: Repository[] = [];
  for (const repo of repositories.values()) {
    if (repo.owner.login === ownerLogin) {
      result.push(repo);
    }
  }
  return result;
}

// Issues
function createIssue(repoData: RepoData, repo: Repository, title: string, body: string | null, labels: string[]): Issue {
  const user = getCurrentUser();
  const issue: Issue = {
    id: nextIssueId++,
    number: repoData.issues.size + 1,
    title,
    body,
    state: 'open',
    user,
    labels: labels.map(name => {
      let label = repoData.labels.get(name);
      if (!label) {
        label = { id: nextLabelId++, name, color: '000000', description: null, default: false };
        repoData.labels.set(name, label);
      }
      return label;
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    repository_url: repo.html_url,
    html_url: `${repo.html_url}/issues/${repoData.issues.size + 1}`,
  };
  repoData.issues.set(issue.number, issue);
  return issue;
}

function getIssue(repoData: RepoData, number: number): Issue | undefined {
  return repoData.issues.get(number);
}

function listIssues(repoData: RepoData, state?: string): Issue[] {
  const issues = Array.from(repoData.issues.values());
  if (state && state !== 'all') {
    return issues.filter(i => i.state === state);
  }
  return issues;
}

// Labels
function createLabel(repoData: RepoData, name: string, color: string, description: string | null): Label {
  const label: Label = {
    id: nextLabelId++,
    name,
    color,
    description,
    default: false,
  };
  repoData.labels.set(name, label);
  return label;
}

function getLabel(repoData: RepoData, name: string): Label | undefined {
  return repoData.labels.get(name);
}

function listLabels(repoData: RepoData): Label[] {
  return Array.from(repoData.labels.values());
}

// Pull Requests
function createPullRequest(
  repoData: RepoData,
  repo: Repository,
  title: string,
  head: string,
  base: string,
  body: string | null
): PullRequest {
  const user = getCurrentUser();
  const prNumber = repoData.pullRequests.size + 1;
  
  // Get commit SHAs for head and base refs
  const headSha = getRef(repoData, `refs/heads/${head}`) ?? '0000000000000000000000000000000000000000';
  const baseSha = getRef(repoData, `refs/heads/${base}`) ?? '0000000000000000000000000000000000000000';
  
  const pr: PullRequest = {
    id: nextPrId++,
    number: prNumber,
    title,
    body,
    state: 'open',
    user,
    head: { ref: head, sha: headSha, repo },
    base: { ref: base, sha: baseSha, repo },
    merged: false,
    mergeable: true,
    merged_at: null,
    merge_commit_sha: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    html_url: `${repo.html_url}/pull/${prNumber}`,
    diff_url: `${repo.html_url}/pull/${prNumber}.diff`,
    patch_url: `${repo.html_url}/pull/${prNumber}.patch`,
  };
  repoData.pullRequests.set(prNumber, pr);
  return pr;
}

function getPullRequest(repoData: RepoData, number: number): PullRequest | undefined {
  return repoData.pullRequests.get(number);
}

function listPullRequests(repoData: RepoData, state?: string): PullRequest[] {
  const prs = Array.from(repoData.pullRequests.values());
  if (state && state !== 'all') {
    return prs.filter(p => p.state === state);
  }
  return prs;
}

function mergePullRequest(repoData: RepoData, number: number): { sha: string; merged: boolean; message: string } | null {
  const pr = repoData.pullRequests.get(number);
  if (!pr || pr.state !== 'open') return null;
  
  // Create a merge commit
  const headSha = pr.head.sha;
  const baseSha = pr.base.sha;
  
  // Get the tree from head commit
  const headCommitObj = getObject(repoData, headSha);
  let treeSha = '';
  if (headCommitObj) {
    const commitData = parseCommitData(headCommitObj.data);
    treeSha = commitData.tree;
  } else {
    // Fallback: create empty tree
    treeSha = storeObject(repoData, 'tree', encodeTree([]));
  }
  
  const mergeCommitData: CommitData = {
    tree: treeSha,
    parents: [baseSha, headSha],
    author: { name: getCurrentUser().name ?? 'Test User', email: getCurrentUser().email ?? 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
    committer: { name: getCurrentUser().name ?? 'Test User', email: getCurrentUser().email ?? 'test@example.com', timestamp: Math.floor(Date.now() / 1000) },
    message: `Merge pull request #${number} from ${pr.head.ref}\n\n${pr.title}`,
  };
  
  const mergeCommitBuffer = formatCommit(mergeCommitData);
  const mergeCommitSha = storeObject(repoData, 'commit', mergeCommitBuffer);
  
  // Update base branch to point to merge commit
  setRef(repoData, `refs/heads/${pr.base.ref}`, mergeCommitSha);
  
  // Update PR
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = new Date().toISOString();
  pr.merge_commit_sha = mergeCommitSha;
  pr.updated_at = new Date().toISOString();
  pr.mergeable = false;
  
  return { sha: mergeCommitSha, merged: true, message: 'Pull request merged successfully' };
}

// Git refs for git protocol
function getAllRefs(repoData: RepoData): Map<string, string> {
  return listRefs(repoData);
}

function getHeadRef(repoData: RepoData): string | undefined {
  return getRef(repoData, 'HEAD') ?? getRef(repoData, 'refs/heads/main');
}

function getDefaultBranchSha(repoData: RepoData): string {
  return getRef(repoData, 'refs/heads/main') ?? '0000000000000000000000000000000000000000';
}

// Commit formatting for REST API
function formatCommitForApi(repoData: RepoData, oid: string, repo: Repository): Commit | null {
  const obj = getObject(repoData, oid);
  if (!obj || obj.type !== 'commit') return null;
  
  const commitData = parseCommitData(obj.data);
  
  return {
    sha: oid,
    node_id: oid,
    commit: {
      author: { name: commitData.author.name, email: commitData.author.email, date: new Date(commitData.author.timestamp * 1000).toISOString() },
      committer: { name: commitData.committer.name, email: commitData.committer.email, date: new Date(commitData.committer.timestamp * 1000).toISOString() },
      message: commitData.message,
      tree: { sha: commitData.tree, url: `${repo.html_url}/git/trees/${commitData.tree}` },
      parents: commitData.parents.map(p => ({ sha: p, url: `${repo.html_url}/commits/${p}` })),
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${repo.html_url}/commits/${oid}`,
    html_url: `${repo.html_url}/commit/${oid}`,
    comments_url: `${repo.html_url}/commits/${oid}/comments`,
    author: getCurrentUser(),
    committer: getCurrentUser(),
    parents: commitData.parents.map(p => ({ sha: p, url: `${repo.html_url}/commits/${p}` })),
  };
}

function formatTreeForApi(repoData: RepoData, oid: string, repo: Repository): Tree | null {
  const obj = getObject(repoData, oid);
  if (!obj || obj.type !== 'tree') return null;
  
  const entries = parseTree(obj.data);
  
  return {
    sha: oid,
    url: `${repo.html_url}/git/trees/${oid}`,
    tree: entries.map(e => ({
      path: e.name,
      mode: e.mode,
      type: e.mode.startsWith('100') ? 'blob' : 'tree',
      sha: e.oid,
      size: e.mode.startsWith('100') ? (getObject(repoData, e.oid)?.data.length ?? 0) : 0,
      url: e.mode.startsWith('100') ? `${repo.html_url}/git/blobs/${e.oid}` : `${repo.html_url}/git/trees/${e.oid}`,
    })),
    truncated: false,
  };
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('utf8');
    offset = space + 1;
    const nullByte = data.indexOf(0x00, offset);
    if (nullByte === -1) break;
    const name = data.subarray(offset, nullByte).toString('utf8');
    offset = nullByte + 1;
    if (offset + 20 > data.length) break;
    const oid = data.subarray(offset, offset + 20).toString('hex');
    offset += 20;
    entries.push({ mode, name, oid });
  }
  return entries;
}

function formatBlobForApi(repoData: RepoData, oid: string, repo: Repository): Blob | null {
  const obj = getObject(repoData, oid);
  if (!obj || obj.type !== 'blob') return null;
  
  return {
    sha: oid,
    node_id: oid,
    size: obj.data.length,
    url: `${repo.html_url}/git/blobs/${oid}`,
    content: obj.data.toString('base64'),
    encoding: 'base64',
  };
}

function formatContentItem(repoData: RepoData, entry: TreeEntry, repo: Repository, path: string): ContentItem {
  const obj = getObject(repoData, entry.oid);
  const isDir = obj?.type === 'tree';
  
  return {
    name: entry.name,
    path,
    sha: entry.oid,
    size: obj?.data.length ?? 0,
    url: isDir ? `${repo.html_url}/git/trees/${entry.oid}` : `${repo.html_url}/git/blobs/${entry.oid}`,
    html_url: isDir ? `${repo.html_url}/tree/main/${path}` : `${repo.html_url}/blob/main/${path}`,
    git_url: isDir ? `${repo.git_url}/git/trees/${entry.oid}` : `${repo.git_url}/git/blobs/${entry.oid}`,
    download_url: isDir ? null : `${repo.html_url}/raw/main/${path}`,
    type: isDir ? 'dir' : 'file',
    content: !isDir && obj ? obj.data.toString('base64') : undefined,
    encoding: !isDir ? 'base64' : undefined,
  };
}

// Authentication
function verifyToken(token: string): User | null {
  // In the trial, the token is in MAKEFUN_SHOP_TOKEN
  if (token === SHOP_TOKEN || token === 'test-token') {
    return getCurrentUser();
  }
  return null;
}

export {
  sha1,
  hashObject,
  encodeTree,
  parseCommitData,
  formatCommit,
  getRepoData,
  createRepoData,
  getOrCreateRepoData,
  storeObject,
  getObject,
  getRef,
  setRef,
  deleteRef,
  listRefs,
  getAllRefs,
  getHeadRef,
  getDefaultBranchSha,
  createRepository,
  getRepository,
  updateRepository,
  deleteRepository,
  listUserRepositories,
  createIssue,
  getIssue,
  listIssues,
  createLabel,
  getLabel,
  listLabels,
  createPullRequest,
  getPullRequest,
  listPullRequests,
  mergePullRequest,
  formatCommitForApi,
  formatTreeForApi,
  formatBlobForApi,
  formatContentItem,
  verifyToken,
  getCurrentUser,
  parseTree,
  ZERO_OID,
};