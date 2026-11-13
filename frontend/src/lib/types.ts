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
  /** SSH user its servers deploy as */
  user: string;
  hosts: Host[];
}

export interface ImageTag {
  name: string;
  digest: string;
  pushed: string;
}

/** A variable a playbook reads but never sets: what the playbook form asks for (POST /playbooks/inspect). */
export interface PlayVarInfo {
  name: string;
  required: boolean;
  /** Likely a password, token or key: typed into a hidden field and stored encrypted. */
  secret: boolean;
  /** The playbook's own default (`| default('…')`), used when the field is left empty. */
  default: string | null;
  /** Read as yes/no (`| bool`): shown as a switch. */
  bool: boolean;
  /** From the playbook's comments. */
  desc: string;
}

export interface PlaybookInfo {
  book: string;
  plays: { name: string; hosts?: string; become?: boolean; import?: string }[];
  vars: PlayVarInfo[];
  /** Variables Wharfline passes by itself (image_ref, env_src…). */
  auto: string[];
  notes: string[];
  /** Files the playbook copies or templates that are not in the upload. */
  warnings: string[];
}

export interface JobPlaybook {
  repo: string;
  /** upload: a playbook uploaded with its files (Job.files), path is the playbook among them. */
  kind: "git" | "local" | "builtin" | "script" | "upload";
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
  /** SSH script steps when playbook.kind is "script", else null. */
  script: { name: string; run: string }[] | null;
  /** SSH script jobs: the folder on the servers (SERVICE_PATH). */
  servicePath: string | null;
  /** SSH script jobs: files uploaded to SERVICE_PATH (contents via GET /jobs/{id}/files). */
  files: { path: string; size: number }[];
  /** Current version of the files (each save that changes them makes a new one). */
  filesVer: number | null;
  /** Watched images besides the main one: $VAR_IMAGE, $VAR_TAG, $VAR_IMAGE_REF. */
  extraImages: ExtraImage[];
  /** Build repo (owner/name) of the main image. */
  imageSourceRepo?: string | null;
  inventory: string;
  targets: string[];
  env: string;
  hook: boolean;
  /** Which new tags auto-deploy: "v" | "date" | "any" | "re:<regex>". */
  hookRule: string;
  protected: boolean;
  lock: boolean;
  rollback: boolean;
  last: { status: Status; time: string; duration: string; /** epoch seconds the last run ended */ at: number | null };
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
  /** Name of who created the job (their email if the account is gone); null when not recorded */
  createdByName: string | null;
  /** Whether the shown member may edit this job */
  canEdit: boolean;
  /** Git playbook jobs: plain playbook variables as [name, value] (empty otherwise). */
  playVars: [string, string][];
  /** Git playbook jobs: names of the secret playbook variables (values are never sent). */
  secretVarNames: string[];
  /** A Docker Compose app: Wharfline writes the script. */
  compose: boolean;
  /** Compose apps from a repo: the file inside it; null when the file was pasted. */
  composePath: string | null;
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
  activeCount?: number; // how many builds of the repo run now (the one shown is the newest started)
}

/** GET /api/jobs/{id}/images: an image the job follows, with the tags collected and its recent builds. */
export interface JobImage {
  ref: string;
  var: string; // "" = the main image (IMAGE_TAG)
  tagNow: string;
  literal: string | null; // a tag written in the file: watched, never picked
  sourceRepo: string | null;
  tags: { name: string; digest: string; pushedAt: number | null; build: Build | null }[];
  builds: Build[];
}

export interface ExtraImage {
  ref: string;
  var: string;
  defaultTag: string;
  tagNow: string;
  tags?: string[];
  latestTag?: string | null;
  sourceRepo?: string | null;
  build?: Build | null;
  /** Watched only (no variable): the tag written in the file. */
  literal?: string | null;
}

export interface BundleFile {
  path: string;
  size: number;
  content?: string;
  warnings?: string[];
}

export interface Run {
  no: number;
  job: string;
  jobId: string;
  target: string;
  tag: string;
  status: Status;
  extraTags?: Record<string, string>;
  /** Version of the job files this run deployed. */
  filesVer?: number | null;
  by: string;
  trigger: string;
  time: string;
  /** epoch seconds the run started (null for old sample runs) */
  at: number | null;
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
  /** How each job uses it (registry list only). */
  usage?: ImageUsage[];
}

export interface ImageUsage {
  job: string;
  jobId: string;
  inventory: string;
  targets: string[];
  hook: boolean;
  hookRule: string;
  /** main: the job's image · var: a tag variable in its file · fixed: a version written in its file */
  role: "main" | "var" | "fixed";
  var: string | null;
  tagNow: string | null;
  literal: string | null;
}

export interface Repo {
  id: number;
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
  /** What to look at now, most serious first (at most 8; alertsMore counts the rest) */
  alerts: DashboardAlert[];
  alertsMore: number;
  recentRuns: Run[];
  /** Runs waiting for an Owner/Admin to approve, oldest first */
  pendingApprovals: Run[];
  jobs: Job[];
}

/** One item of the dashboard's 알림 card. `run` opens that run's log; `to` is a page to fix it on. */
export interface DashboardAlert {
  kind: "hostKey" | "failed" | "approval" | "offline" | "tfa";
  tone: "bad" | "warn" | "neutral";
  title: string;
  sub: string;
  run?: number;
  to?: string;
}

export type NotifyChannel = "ntfy" | "slack" | "discord";
export type NotifyEvent = "ok" | "bad" | "cancel" | "approval";
export type NotifySecretKey = "ntfyToken" | "slackUrl" | "discordUrl";
export interface NotifyConfig {
  baseUrl: string;
  events: Record<NotifyEvent, boolean>;
  autoOnly: boolean;
  ntfy: { on: boolean; server: string; topic: string };
  slack: { on: boolean };
  discord: { on: boolean };
}
export interface NotifySettings extends NotifyConfig {
  secrets: Record<NotifySecretKey, { set: boolean; last4: string }>;
  status: Partial<Record<NotifyChannel, { at: number; ok: boolean; error?: string; errorAt?: number }>>;
}
