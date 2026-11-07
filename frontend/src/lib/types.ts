export type Status = "ok" | "bad" | "run" | "cancel" | "warn";
export type Role = "Owner" | "Admin" | "Deployer" | "Viewer";

export interface Me {
  name: string;
  role: Role;
  email: string;
  /** Group names */
  groups: string[];
}

export interface Session {
  loggedIn: boolean;
  me: Me;
  sudoUntil: number;
  sudoMinutes: number;
}

export interface Host {
  name: string;
  ip: string;
  port: number;
  user: string;
  group: string;
  hostKey: "ok" | "changed";
  status: "on" | "off";
  skip?: string;
}

export interface Inventory {
  id: string;
  name: string;
  key: string;
  hosts: Host[];
}

export interface ImageTag {
  name: string;
  digest: string;
  pushed: string;
}

export interface JobPlaybook {
  repo: string;
  kind: "git" | "local" | "builtin";
  url: string;
  branch: string;
  path: string;
}

export interface Job {
  id: string;
  name: string;
  /** Image ref without a tag; null for a job that runs the playbook without an image */
  image: string | null;
  tagNow: string;
  defaultTag: string;
  playbook: JobPlaybook;
  inventory: string;
  targets: string[];
  env: string;
  hook: boolean;
  protected: boolean;
  lock: boolean;
  rollback: boolean;
  last: { status: Status; time: string; duration: string };
  inventoryHostCount: number;
  targetLabel: string;
  targetHosts: Host[];
  groups: Record<string, Host[]>;
  imageTags: ImageTag[];
  latestTag: string | null;
  prevTag: string | null;
  build: Build | null;
  /** Who besides Owner/Admin and the creator may edit: group ids and member emails */
  editors: { groups: string[]; members: string[] };
  /** Email of the member who created the job */
  createdBy: string | null;
  /** Whether the shown member may edit this job */
  canEdit: boolean;
}

export type GitProvider = "gitea" | "github" | "gitlab";

export interface Build {
  id: number;
  provider: GitProvider;
  repo: string;
  runId: number;
  runNumber: number | null;
  workflow: string;
  title: string;
  status: "queued" | "in_progress" | "success" | "failure" | "cancelled" | "skipped";
  active: boolean;
  branch: string | null;
  sha: string | null;
  url: string | null;
  step: string | null;
  tag: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface Run {
  no: number;
  job: string;
  jobId: string;
  target: string;
  tag: string;
  status: Status;
  by: string;
  trigger: string;
  time: string;
  duration: string;
  steps?: string[];
}

export type RunEvent =
  | { t: "step"; i: number; state: "run" | "ok" | "bad"; d?: string }
  | { t: "line"; c: string; text: string; ts: string }
  | { t: "done"; status: Status; duration: string }
  | { t: "cancel" };

export interface RunDetail extends Run {
  live: boolean;
  events: RunEvent[];
  method?: string;
  image?: string;
  inventory?: string;
  build?: Build | null;
}

export interface Registry {
  id: string;
  name: string;
  host: string;
  namespace: string;
  auth: string;
  user: string;
  imageCount: number;
  hasSecret?: boolean;
}

export interface Image {
  ref: string;
  registry: string;
  sourceRepo: string | null;
  tags: ImageTag[];
  usedBy: string[];
}

export interface Repo {
  name: string;
  kind: "git" | "local" | "builtin";
  url: string;
  branch: string;
  auth: string;
  commit: string;
  usedBy: { job: string; path: string }[];
}

export interface Key {
  id: string;
  kind: "ssh" | "token";
  name: string;
  type: string;
  fingerprint: string;
  createdBy: string;
  createdAt: string;
  lastUsed: string;
  usedCount: number;
  publicKey?: string;
  hasSecret?: boolean;
}

export interface EnvSet {
  id: string;
  name: string;
  ver: number;
  updated: string;
  vars: { key: string }[]; // names only; values need /values with a recent sudo
  usedBy: string[];
}

export interface EnvDiff {
  add: string[];
  chg: string[];
  del: string[];
}

export interface EnvHistory {
  name: string;
  ver: number;
  items: { ver: number; updated: string; count: number; current: boolean; prevVer: number | null; diff: EnvDiff | null }[];
}

export interface Activity {
  time: string;
  user: string;
  action: string;
  object: string;
  ip: string;
  result: Status;
}

export interface Login {
  time: string;
  user: string;
  method: string;
  ip: string;
  location: string;
  agent: string;
  result: "ok" | "bad" | "warn";
}

export interface Member {
  name: string;
  email: string;
  role: Role;
  tfa: boolean;
  last: string;
  /** Group ids */
  groups: string[];
}

/** Members of a group see its menus and the builds of its repos. */
export interface Group {
  id: string;
  name: string;
  menus: string[];
  allBuilds: boolean;
  repos: string[];
  /** Member emails */
  members: string[];
}

export interface Policy {
  enforce2fa: boolean;
  sudoMinutes: number;
  session: string;
  lockout: string;
  allowIps: string;
}

export interface Dashboard {
  me: Me;
  stats: {
    today: number;
    todayOk: number;
    todayBad: number;
    successRate: string;
    successDelta: string;
    hostsOnline: number;
    hostsTotal: number;
    avgDuration: string;
  };
  hostKeyAlert: Host | null;
  recentRuns: Run[];
  jobs: Job[];
  security: { tfaUsers: number; members: number };
}
