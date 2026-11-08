/** "approval": waiting for an Owner/Admin to approve a protected job; "rejected": they said no. */
export type Status = "ok" | "bad" | "run" | "cancel" | "warn" | "approval" | "rejected";
export type Role = "Owner" | "Admin" | "Deployer" | "Viewer";

export interface Me {
  name: string;
  role: Role;
  email: string;
  /** Group names */
  groups: string[];
}

/** What still stands between a login and being signed in. */
export type LoginStep = "totp" | "password" | "tfa_setup";

export interface Session {
  loggedIn: boolean;
  me: Me;
  /** Set while a login is half done; `me` is null then. */
  step: LoginStep | null;
  pendingEmail: string | null;
  /** Whether I have 2-step verification on, and how many recovery codes are left. */
  tfa: boolean;
  recoveryCodes: number;
  enforce2fa: boolean;
  /** Sample data is loaded (development), so the login screen lists the sample accounts. */
  sampleData?: boolean;
  sudoUntil: number;
  sudoMinutes: number;
}

/** One signed-in browser of mine. Times are epoch ms. */
export interface DeviceSession {
  id: string;
  agent: string;
  ip: string;
  createdAt: number;
  lastSeen: number;
  current: boolean;
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
  /** Email and name of who asked for the run (null for auto-deploy and old runs) */
  requestedBy: string | null;
  requestedByName: string | null;
  /** Who approved or rejected it, and when (ISO time) */
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
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
  /** SSH keys: inventories that connect with this key. */
  inventories?: string[];
  /** One SSH key serves 2+ inventories (e.g. production and staging). */
  sharedAcrossInventories?: boolean;
}

/** GET /keys/{id}/public */
export interface PublicKeyInfo {
  publicKey: string;
  /** The line to put in authorized_keys: with from="…" and forwarding off when addresses are set. */
  authorizedKeysLine: string;
  restricted: boolean;
  accessFrom: string[];
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
  /** Too many failed logins; an Owner's password reset unlocks. */
  locked?: boolean;
  /** Signed in next with a temporary password and must pick a new one. */
  mustChangePassword?: boolean;
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
  /** Runs waiting for an Owner/Admin to approve, oldest first */
  pendingApprovals: Run[];
  jobs: Job[];
  security: { tfaUsers: number; members: number };
}
