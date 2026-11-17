// Core storage types and in-memory database for the git forge

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
  oid: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: { name: string; email: string; timestamp: number };
  committer: { name: string; email: string; timestamp: number };
  message: string;
}

export interface Ref {
  name: string;
  oid: string;
}

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: User;
  private: boolean;
  description: string | null;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  html_url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
}

export interface User {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  html_url: string;
  type: 'User';
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: User;
  labels: Label[];
  assignee: User | null;
  assignees: User[];
  milestone: unknown | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  repository_url: string;
  html_url: string;
  pull_request?: { url: string; html_url: string; diff_url: string; patch_url: string };
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
  default: boolean;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: User;
  head: { ref: string; sha: string; repo: Repository };
  base: { ref: string; sha: string; repo: Repository };
  merged: boolean;
  mergeable: boolean | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  diff_url: string;
  patch_url: string;
}

export interface GitRef {
  ref: string;
  node_id: string;
  url: string;
  object: { sha: string; type: string; url: string };
}

export interface Commit {
  sha: string;
  node_id: string;
  commit: {
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
    message: string;
    tree: { sha: string; url: string };
    parents: Array<{ sha: string; url: string }>;
    verification: { verified: boolean; reason: string; signature: string | null; payload: string | null };
  };
  url: string;
  html_url: string;
  comments_url: string;
  author: User | null;
  committer: User | null;
  parents: Array<{ sha: string; url: string }>;
}

export interface Tree {
  sha: string;
  url: string;
  tree: Array<{
    path: string;
    mode: string;
    type: 'blob' | 'tree';
    sha: string;
    size: number;
    url: string;
  }>;
  truncated: boolean;
}

export interface Blob {
  sha: string;
  node_id: string;
  size: number;
  url: string;
  content: string;
  encoding: 'base64';
}

export interface ContentItem {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string | null;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  content?: string;
  encoding?: 'base64';
  target?: string;
}

export interface PushResult {
  ref: string;
  old_sha: string;
  new_sha: string;
  forced: boolean;
  status: 'ok' | 'ng';
  message: string | null;
}