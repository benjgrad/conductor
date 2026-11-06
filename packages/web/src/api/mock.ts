import {
  API_PATHS,
  attachmentProblem,
  sanitizeAttachmentName,
  type AttachmentDto,
  ADMIN_USER_ROW_FIXTURES,
  proposalLimitsOf,
  AnswerInputRequestSchema,
  ApproveProposalRequestSchema,
  DismissProposalRequestSchema,
  proposalsOfContext,
  proposalTicketBody,
  withDecisions,
  type ProposalDecision,
  type TicketProposal,
  boardColumns as defaultBoardColumns,
  checksGatesOf,
  CreateInviteRequestSchema,
  CreateTicketRequestSchema,
  UpdateTicketRequestSchema,
  SetSkipPermissionsRequestSchema,
  effectiveSkipPermissions,
  ReorderQueueRequestSchema,
  compareQueued,
  isReorderable,
  type QueueOrderResponse,
  ticketEditable,
  ENROLLMENT_TOKEN_TTL_MS,
  humanTransitionOptions,
  INVITE_DEFAULT_DAYS,
  INVITE_ROW_FIXTURES,
  localMeResponse,
  LoginRequestSchema,
  ME_RESPONSE_FIXTURE,
  PasswordChangeRequestSchema,
  passwordProblems,
  placeCard,
  PutRepoChecksRequestSchema,
  RepoChecksSchema,
  repoChecksKey,
  repoHealth,
  runsByCheck,
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  formatScheduleTime,
  nextRunAfter,
  nextRuns,
  SCHEDULE_PREVIEW_RUNS,
  validateSchedule,
  type ScheduleDto,
  type TicketStatus,
  rankRepos,
  MachineRowSchema,
  TeamResponseSchema,
  RenameMachineRequestSchema,
  UpdateMachineRequestSchema,
  ReopenSessionRequestSchema,
  RESET_LINK_TTL_MS,
  ResetRequestSchema,
  RETURN_TO,
  SendMessageRequestSchema,
  SignupRequestSchema,
  TransitionSessionRequestSchema,
  FreshConversationRequestSchema,
  PermissionDecisionRequestSchema,
  permissionSummary,
  FRESH_CONVERSATION_MOVE,
  type AdminUserRow,
  type AuthMode,
  type BoardCard,
  type BoardResponse,
  type BoardSseEvent,
  type BoardSseEventDraft,
  type InputRequestKind,
  type InviteRow,
  type EnrollmentTokenCreated,
  type MachineDetail,
  type MachineRow,
  type MeResponse,
  type MoveDto,
  type OkResponse,
  type OutputChunk,
  type OutputStream,
  type PermissionRequestDto,
  type RepoChecksDetail,
  type RepoCheckRunsResponse,
  type RepoChecksHealthResponse,
  type ChangeProposalDetail,
  type ChangeProposalListResponse,
  type ChangeProposalSummary,
  type RepoChecksDto,
  type ReopenSessionResponse,
  type SessionDetail,
  type SessionInputRequest,
  type SessionStatus,
  type TicketDetail,
  type TicketDto,
  type TicketSearchResponse,
  type TicketSearchResult,
  ticketSearchGroup,
  validateWorkflow,
  DIFF_MAX,
  capDiff,
  diffWorkflow,
  stableJson,
  type WorkflowDefaultResponse,
  type WorkflowDefinition,
  type WorkflowDetail,
  type TranscriptResponse,
  type WorkflowSummary,
  AVAILABLE_WORKFLOW_FEATURES,
  ticketBaseProblems,
  type TicketBase,
} from '@conductor/shared';
import {
  ApiRequestError,
  type ApiClient,
  type SaveWorkflowResponse,
  type StreamHandlers,
  type Unsubscribe,
} from './client.js';
import { validateColumns } from '../workflow/columns.js';
import { mockInsights } from './mock-insights.js';
import {
  CONDUCTOR,
  MOCK_WORKFLOW_AUTHORS,
  MOCK_TEAM,
  MOCK_WORKFLOW_HISTORY,
  mockMachines,
  mockRepoChecks,
  mockCheckRuns,
  mockChangeProposals,
  mockSchedules,
  mockSeeds,
  SEED_IDS,
  type MockSession,
} from './mock-data.js';

// In-memory ApiClient for T09 (and tests). It mimics the orchestrator's observable behaviour:
// every change is an id-ordered board event (card.upserted last, carrying the full card), the
// board stream replays from Last-Event-ID, answers are idempotent per input_request_id, and
// errors use the 10-contracts REST error map codes. It does NOT run the workflow engine: an
// answer simply moves the session to `goto` (or `return_to`) and marks it running; a human
// transition (ADR-0011) moves it to the button's `goto`, with no requirements run.

/** Up to 200 characters of `text` around `q` (as the server's `snippetOf`). */
function mockSnippet(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(q);
  const start = at < 0 ? 0 : Math.max(0, at - 60);
  const cut = flat.slice(start, start + 198);
  return (start > 0 ? '…' : '') + cut + (start + cut.length < flat.length ? '…' : '');
}

export interface MockApiOptions {
  /** Clock for seeds and new rows. Default: real time. */
  now?: () => Date;
  /** Artificial latency on every request, ms. Default 0. */
  latencyMs?: number;
  /** Delay before the fake agent replies to a sendMessage, ms. Default 700. */
  replyDelayMs?: number;
  /**
   * M2-T05. `local` (default): `me()` is the local user and nothing needs a session. `password`:
   * one admin user (MOCK_ADMIN) and two open invites (MOCK_INVITE_TOKENS); the auth and admin
   * calls behave like 10-contracts §Accounts and web auth.
   */
  auth?: AuthMode;
  /** `password` mode: start signed in as the admin. Default true. */
  signedIn?: boolean;
  /** UX-8: `none` starts the account with no machines (the first-run guide). Default `seeded`. */
  machines?: 'seeded' | 'none';
  /**
   * UXR-87: a newer shipped `conductor` default. While no stored version equals it, `getWorkflow`
   * reports its version as `default_available`, and `adoptDefaultWorkflow` saves it. Default none.
   */
  defaultWorkflow?: WorkflowDefinition;
  /**
   * ADR-0039 (B3): the base-refs scene (`?mock-bases=1`). `conductor` gains `bases` and
   * `base_default`, a queued card names a base, a running one has a resolved `base_ref`, and ticket
   * bases are accepted (the app treats the feature as available, workflow/features.ts).
   */
  bases?: boolean;
}

/** ADR-0039: the mock base-refs scene's `bases` (the v7 draft's, shortened). */
export const MOCK_BASES: NonNullable<WorkflowDefinition['bases']> = {
  default: { ref: '$default_branch' },
  sprint: {
    cmd: "git ls-remote --heads origin | grep -E -- '-sb-[12]$' | sort -V | tail -n 1",
    timeout: '1m',
  },
  master: { ref: 'master' },
  hotfix: { cmd: 'az pipelines runs list --top 1 --query [0].sourceVersion', pr_into: 'master' },
};

/** The mock's one user in `password` mode (an admin). */
export const MOCK_ADMIN = { email: 'ben@example.com', password: 'correct horse battery' } as const;
/** Tokens of the mock's two invites: one pinned to dana@example.com, one open to anyone. */
export const MOCK_INVITE_TOKENS = {
  pinned: 'mock-invite-pinned',
  open: 'mock-invite-open',
} as const;
const INVALID_CREDENTIALS = 'Email or password is wrong';

export interface MockApi extends ApiClient {
  /** Test/dev hooks: drive the board like a daemon would. */
  pushOutput(sessionId: string, text: string, stream?: OutputStream): void;
  requestInput(sessionId: string, kind: InputRequestKind, question: string): string;
  /** UX-5: change a session's card as the engine would (e.g. the next check), with card.upserted. */
  updateCard(sessionId: string, next: Partial<BoardCard>): void;
  /** Appends fake output to every running session every `ms`; returns a stop function. */
  simulate(ms: number): Unsubscribe;
  /** `password` mode: lock a user's email, as repeated failed sign-ins would. */
  lockUser(email: string): void;
  /**
   * UX-8: a machine enrolls and comes online, as a daemon would after the install command;
   * `patch` overrides its fields (e.g. its capabilities). Returns its id.
   */
  connectMachine(patch?: Partial<MachineDetail>): string;
  /** UX-8: a machine's new inventory report (repos, capabilities). */
  updateMachine(id: string, patch: Partial<MachineDetail>): void;
  /**
   * ADR-0023: the agent asks for a tool (a pending permission request), as the gateway stores a
   * daemon's `permission_request`; the card shows `needs_permission`. Returns the request id.
   */
  requestPermission(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
    alwaysRule?: string | null,
  ): string;
}

interface MockUser {
  row: AdminUserRow;
  password: string;
}

const TERMINAL: ReadonlySet<SessionStatus> = new Set(['done', 'failed', 'lost']);

/** ADR-0010: the board's columns (conductor v1's; the mock doesn't edit them). */
const COLUMNS = defaultBoardColumns(null);

export function createMockApi(opts: MockApiOptions = {}): MockApi {
  const now = opts.now ?? (() => new Date());
  const latency = opts.latencyMs ?? 0;
  const replyDelay = opts.replyDelayMs ?? 700;
  /** ADR-0039 (B3): the base-refs scene. */
  const basesScene = opts.bases === true;
  const cards = new Map<string, BoardCard>();
  const sessions = new Map<string, MockSession>();
  const answered = new Set<string>();
  /** ADR-0023: permission requests by session, oldest first. */
  const permissions = new Map<string, PermissionRequestDto[]>();
  // ADR-0039: each ticket's skip-permissions setting (absent ≡ null, the machine's default).
  const skipPermissions = new Map<string, boolean | null>();
  const log: BoardSseEvent[] = [];
  const boardSubs = new Set<StreamHandlers<BoardSseEvent>>();
  const outputSubs = new Map<string, Set<StreamHandlers<OutputChunk>>>();
  let nextEventId = 1;
  /** Ticket fields the cards don't carry (body, repo rules), by ticket id; seeded on first read. */
  const tickets = new Map<string, TicketDto & { updated_at: string }>();
  /** 06 §Attachments: uploads, linked (`ticket_id`) or not; `src` is what an <img> loads. */
  const attachments = new Map<
    string,
    { dto: AttachmentDto; ticketId: string | null; src: string }
  >();
  const attachmentsOf = (ticketId: string): AttachmentDto[] =>
    [...attachments.values()].filter((a) => a.ticketId === ticketId).map((a) => clone(a.dto));
  /** Link uploads to a ticket, as the server does (400 for unknown or already linked ones). */
  const linkUploads = (ticketId: string, ids: readonly string[]) => {
    for (const id of ids) {
      const a = attachments.get(id);
      if (!a || a.ticketId !== null) {
        throw new ApiRequestError(400, 'bad_request', 'unknown or already linked attachment');
      }
    }
    for (const id of ids) attachments.get(id)!.ticketId = ticketId;
  };
  /** Workflow versions per id, oldest first (version N at index N-1). */
  const workflows = new Map<
    string,
    {
      definition: WorkflowDefinition;
      created_at: string;
      created_by: string | null;
      note: string | null;
    }[]
  >(
    Object.entries(MOCK_WORKFLOW_HISTORY).map(([id, defs]) => [
      id,
      defs.map((definition, i) => ({
        definition,
        created_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
        created_by: MOCK_WORKFLOW_AUTHORS[id]?.[i]?.created_by ?? null,
        note: MOCK_WORKFLOW_AUTHORS[id]?.[i]?.note ?? null,
      })),
    ]),
  );

  /** UXR-87: `opts.defaultWorkflow`'s version while no stored `conductor` equals it, else null. */
  const defaultAvailable = (id: string): number | null => {
    const def = opts.defaultWorkflow;
    const versions = workflows.get(id);
    if (!def || id !== CONDUCTOR.id || !versions) return null;
    const norm = (d: WorkflowDefinition) => stableJson({ ...d, version: 0 });
    return versions.some((v) => norm(v.definition) === norm(def)) ? null : def.version;
  };

  /** ADR-0030: per-repo check overrides, by `repoChecksKey`. */
  const repoChecks = new Map<string, RepoChecksDto>(
    mockRepoChecks(now()).map((dto) => [dto.repo, dto]),
  );
  /** UXR-80: past check runs (what `loadCheckRuns` reads). */
  const checkRuns = mockCheckRuns(now());

  /** ADR-0033 P3: the advisor's change proposals, newest first. */
  const proposals: ChangeProposalDetail[] = mockChangeProposals(now());
  /** UXR-84: the advisor's metrics, findings, report and session insights. */
  const insights = mockInsights(now(), () => proposals);
  const proposal = (id: string): ChangeProposalDetail => {
    const p = proposals.find((x) => x.id === id);
    if (!p) throw new ApiRequestError(404, 'not_found', 'no such change proposal');
    return p;
  };
  const summaryOf = (p: ChangeProposalDetail): ChangeProposalSummary => ({
    id: p.id,
    kind: p.kind,
    status: p.status,
    title: p.title,
    target: p.target,
    requires_admin: p.requires_admin,
    changes: p.changes,
    expected_effect: p.expected_effect,
    created_at: p.created_at,
    applied_at: p.applied_at,
    ticket_id: p.ticket_id ?? null,
  });
  const mustBeProposed = (p: ChangeProposalDetail) => {
    if (p.status !== 'proposed') {
      throw new ApiRequestError(409, 'wrong_state', `The proposal is ${p.status}, not proposed.`);
    }
  };

  /** The card's column per the shared rule (placeCard), by its session's workflow. */
  function columnOf(card: BoardCard): string {
    const wf = card.session_id ? (sessions.get(card.session_id)?.workflow ?? null) : null;
    const session =
      card.session_id === null || card.status === null
        ? null
        : {
            status: card.status,
            workflow_state: card.workflow_state,
            waiting_for_build_slot: false,
            context: {},
          };
    return placeCard(ticketStatusOf(card), session, { columns: COLUMNS, def: wf }).column;
  }

  /** The ticket's status as the server keeps it, from its card (cancelled cards are badged). */
  function ticketStatusOf(card: BoardCard): TicketStatus {
    if (card.badges.includes('cancelled')) return 'cancelled';
    if (card.status === 'done') return 'done';
    if (card.status === 'failed' || card.status === 'lost') return 'failed';
    return card.session_id === null || card.status === null ? 'ready' : 'in_progress';
  }

  for (const s of mockSeeds(now())) {
    if (s.session && s.card.session_id) sessions.set(s.card.session_id, s.session);
    cards.set(s.card.ticket_id, { ...s.card, column: columnOf(s.card) });
  }

  if (basesScene) {
    // ADR-0039 (B3): the base-refs scene.
    const latest = workflows.get(CONDUCTOR.id)?.at(-1);
    if (latest) {
      latest.definition = {
        ...latest.definition,
        bases: MOCK_BASES,
        base_default: { work: 'sprint', personal: 'default' },
      };
    }
    const queued = cards.get(SEED_IDS.queuedUrgent.ticket);
    if (queued) cards.set(queued.ticket_id, { ...queued, base: 'master' });
    const running = cards.get(SEED_IDS.running.ticket);
    if (running) {
      cards.set(running.ticket_id, {
        ...running,
        base_ref: {
          name: 'sprint',
          ref: 'ncng-26-sb-2',
          sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          pr_into: null,
        },
      });
    }
  }
  /** ADR-0039: what a ticket's `base` is refused for, as the server's `ticketBaseProblems`. */
  const baseRefusal = (base: TicketBase, workflowId: string): string | null => {
    const def = workflows.get(workflowId)?.at(-1)?.definition ?? null;
    const problems = ticketBaseProblems(
      def,
      base,
      basesScene ? [...AVAILABLE_WORKFLOW_FEATURES, 'bases'] : AVAILABLE_WORKFLOW_FEATURES,
    );
    return problems[0]?.message ?? null;
  };
  const refuseBase = (base: TicketBase, workflowId: string) => {
    const message = baseRefusal(base, workflowId);
    if (message !== null) {
      throw new ApiRequestError(400, 'bad_request', message, [{ path: 'base', message }]);
    }
  };

  /** ADR-0032: recurring jobs by id; a seeded schedule's last ticket names it on its card. */
  const schedules = new Map<string, ScheduleDto>(mockSchedules(now()).map((d) => [d.id, d]));
  for (const sc of schedules.values()) {
    const card = sc.last_ticket ? cards.get(sc.last_ticket.id) : undefined;
    if (card) cards.set(card.ticket_id, { ...card, schedule: { id: sc.id, name: sc.name } });
  }

  // M2-T05: accounts. `session` is the signed-in user's id (null = signed out).
  const authMode: AuthMode = opts.auth ?? 'local';
  const day = 24 * 60 * 60_000;
  const isoIn = (ms: number) => new Date(now().getTime() + ms).toISOString();
  const users = new Map<string, MockUser>();
  const admin = { ...ADMIN_USER_ROW_FIXTURES.admin, created_at: isoIn(-30 * day) };
  users.set(admin.id, { row: admin, password: MOCK_ADMIN.password });
  let session: string | null = authMode === 'password' && opts.signedIn !== false ? admin.id : null;
  /** Invites by token, newest first in `listInvites`. */
  const invites = new Map<string, InviteRow>([
    [
      MOCK_INVITE_TOKENS.pinned,
      {
        ...INVITE_ROW_FIXTURES.open,
        created_at: isoIn(-2 * day),
        expires_at: isoIn(5 * day),
      },
    ],
    [
      MOCK_INVITE_TOKENS.open,
      {
        ...INVITE_ROW_FIXTURES.open,
        id: crypto.randomUUID(),
        email: null,
        created_at: isoIn(-1 * day),
        expires_at: isoIn(6 * day),
      },
    ],
  ]);
  const resets = new Map<string, { userId: string; expires_at: string; used: boolean }>();
  let issued = 0;

  // M2-T11: two machines (mbp-ben online with an open alert; an old, outdated one offline).
  // running_sessions and live_sessions come from the cards; the rest is stored here.
  const machines = new Map(
    opts.machines === 'none' ? [] : mockMachines(now()).map((m) => [m.id, m]),
  );
  let connected = 0;

  function machineOf(id: string): MachineDetail {
    const m = machines.get(id);
    if (!m) throw new ApiRequestError(404, 'not_found', `machine ${id} not found`);
    const live = [...cards.values()].filter(
      (c) =>
        c.machine_id === id &&
        c.session_id !== null &&
        c.status !== null &&
        !TERMINAL.has(c.status),
    );
    return clone({
      ...m,
      running_sessions: live.filter((c) => c.status === 'running').length,
      live_sessions: live.map((c) => ({
        session_id: c.session_id!,
        ticket_id: c.ticket_id,
        title: c.title,
      })),
    });
  }

  function machineRow(id: string): MachineRow {
    const m = machineOf(id);
    // The schema strips the detail-only fields, as the server's row has none.
    return MachineRowSchema.parse({ ...m, repo_count: m.repos.length });
  }

  const inviteOpen = (row: InviteRow | undefined): row is InviteRow =>
    row !== undefined &&
    row.used_at === null &&
    row.revoked_at === null &&
    Date.parse(row.expires_at) > now().getTime();

  function meFor(user: MockUser): MeResponse {
    const { id, email, display_name, is_admin } = user.row;
    return {
      ...ME_RESPONSE_FIXTURE,
      user: { id, email, display_name, is_admin },
      account: { id: ME_RESPONSE_FIXTURE.account.id, name: display_name },
    };
  }

  function signedInUser(): MockUser {
    const user = session === null ? undefined : users.get(session);
    if (!user || user.row.disabled_at !== null) {
      throw new ApiRequestError(401, 'unauthorized', 'Sign in to continue');
    }
    return user;
  }

  function requireAdmin(): void {
    if (authMode === 'local') throw new ApiRequestError(403, 'forbidden', 'Admins only');
    if (!signedInUser().row.is_admin) throw new ApiRequestError(403, 'forbidden', 'Admins only');
  }

  function userById(id: string): MockUser {
    const user = users.get(id);
    if (!user) throw new ApiRequestError(404, 'not_found', `user ${id} not found`);
    return user;
  }

  function badRequest(message: string, details: { path: string; message: string }[] = []) {
    return new ApiRequestError(400, 'bad_request', message, details);
  }

  function passwordError(password: string, email: string): ApiRequestError | null {
    const problems = passwordProblems(password, email);
    if (problems.length === 0) return null;
    return badRequest(
      problems.join(' '),
      problems.map((message) => ({ path: 'password', message })),
    );
  }

  const pushDisabled = (): never => {
    throw new ApiRequestError(
      404,
      'push_disabled',
      'push notifications are not configured on this server',
    );
  };

  const reply = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve, reject) => {
      const run = () => {
        try {
          resolve(fn());
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      if (latency > 0) setTimeout(run, latency);
      else queueMicrotask(run);
    });

  const clone = <T>(v: T): T => structuredClone(v);

  function emit(drafts: BoardSseEventDraft[]) {
    const ts = now().toISOString();
    const events = drafts.map((d) => ({
      ...(d.type === 'card.upserted' ? { ...d, card: withProposalCount(d.card) } : d),
      id: nextEventId++,
      ts,
    }));
    log.push(...events);
    // Snapshot the subscribers: one that subscribes later gets these from its replay backlog.
    const subs = [...boardSubs];
    queueMicrotask(() => {
      for (const ev of events)
        for (const sub of subs) if (boardSubs.has(sub)) sub.onEvent(clone(ev));
    });
  }

  /** A new queued ticket and its card (card.upserted), as POST /api/tickets makes it. */
  function addTicket(
    req: ReturnType<typeof CreateTicketRequestSchema.parse>,
    schedule?: { id: string; name: string },
  ): TicketDto {
    const created_at = now().toISOString();
    const ticket: TicketDto = {
      id: crypto.randomUUID(),
      external_ref: req.external_ref,
      repo: req.repo,
      title: req.title,
      body: req.body,
      workflow_id: req.workflow_id,
      workflow_version: null,
      required_tags: req.required_tags,
      repo_allow_machines: req.repo_allow_machines,
      status: 'ready',
      priority: req.priority,
      size: req.size,
      base: req.base ?? null,
      created_at,
    };
    const card: BoardCard = {
      ticket_id: ticket.id,
      session_id: null,
      title: ticket.title,
      external_ref: ticket.external_ref,
      repo: ticket.repo,
      priority: ticket.priority,
      workflow_id: ticket.workflow_id,
      workflow_state: null,
      status: null,
      column: 'queued',
      badges: [],
      checking: null,
      // ADR-0011 card fields (M1b-T01 contract; M1b-T07 owns the mock).
      kind: req.kind ?? null,
      size: req.size,
      base_ref: null,
      base: req.base ?? null,
      pending: null,
      watching: null,
      human_transitions: [],
      pr_url: null,
      machine_id: null,
      spend_usd: 0,
      input_request: null,
      ...(schedule ? { schedule } : {}),
      created_at,
      updated_at: created_at,
    };
    linkUploads(ticket.id, req.attachment_ids ?? []);
    cards.set(card.ticket_id, card);
    tickets.set(ticket.id, { ...ticket, kind: req.kind ?? null, updated_at: created_at });
    emit([{ type: 'card.upserted', session_id: null, ticket_id: card.ticket_id, card }]);
    return clone(ticket);
  }

  /** ADR-0032: a ticket's status as the board shows it (the mock keeps no ticket rows for it). */
  function ticketStatusById(ticketId: string): TicketStatus | null {
    const card = cards.get(ticketId);
    return card ? ticketStatusOf(card) : null;
  }

  /** The schedule as GET /api/schedules shows it now: previews from now, last ticket's status. */
  function scheduleView(sc: ScheduleDto): ScheduleDto {
    const status = sc.last_ticket ? ticketStatusById(sc.last_ticket.id) : null;
    let next_runs: string[] = [];
    if (sc.enabled) {
      try {
        next_runs = nextRuns(sc.cron, sc.timezone, now(), SCHEDULE_PREVIEW_RUNS).map((d) =>
          d.toISOString(),
        );
      } catch {
        next_runs = [];
      }
    }
    return clone({
      ...sc,
      next_runs,
      last_ticket:
        sc.last_ticket && status !== null ? { id: sc.last_ticket.id, status } : sc.last_ticket,
    });
  }

  function scheduleOf(id: string): ScheduleDto {
    const sc = schedules.get(id);
    if (!sc) throw new ApiRequestError(404, 'not_found', `no schedule ${id}`);
    return sc;
  }

  const scheduleBadRequest = (path: string, message: string) =>
    new ApiRequestError(400, 'bad_request', message, [{ path, message }]);

  /** 400 unless `cron` in `tz` is a valid rule at least 15 minutes apart (as `checkRule`). */
  function checkScheduleRule(cron: string, tz: string) {
    const err = validateSchedule(cron, tz, now());
    if (err !== null) {
      throw scheduleBadRequest(err.code === 'invalid_timezone' ? 'timezone' : 'cron', err.message);
    }
  }

  /** Machine ids or names → ids (null / [] = any machine); 400 for an unknown one. */
  function resolveScheduleMachines(refs: readonly string[] | null): string[] | null {
    if (refs === null || refs.length === 0) return null;
    const live = [...machines.values()].filter((m) => m.revoked_at === null);
    const ids: string[] = [];
    for (const ref of refs) {
      const lower = ref.toLowerCase();
      const hit =
        live.find((m) => m.id === ref) ??
        live.find((m) => m.name?.toLowerCase() === lower || m.hostname.toLowerCase() === lower);
      if (!hit) throw scheduleBadRequest('machines', `unknown machine ${ref}`);
      if (!ids.includes(hit.id)) ids.push(hit.id);
    }
    return ids;
  }

  function scheduleNameTaken(name: string, except: string | null) {
    for (const sc of schedules.values()) {
      if (sc.name === name && sc.id !== except) {
        throw new ApiRequestError(409, 'conflict', `a schedule named ${name} already exists`, [
          { path: 'name', message: 'already used by another schedule' },
        ]);
      }
    }
  }

  const zodBadRequest = (issues: { path: PropertyKey[]; message: string }[]) =>
    new ApiRequestError(
      400,
      'bad_request',
      'invalid schedule',
      issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );

  /** A stored `updated_at` strictly later than `prev` (the mock clock may be frozen). */
  const bumpedAt = (prev: string) =>
    new Date(Math.max(now().getTime(), Date.parse(prev) + 1)).toISOString();

  /** 06 §Proposed tickets: decisions by ticket, then proposal id. */
  const proposalDecisions = new Map<string, Map<string, ProposalDecision>>();

  /** The card's proposals (its session's context) with their decisions, as the server reads them. */
  function proposalsOf(card: BoardCard): TicketProposal[] {
    const s = card.session_id ? sessions.get(card.session_id) : undefined;
    if (!s) return [];
    return withDecisions(
      proposalsOfContext(s.context, proposalLimitsOf(s.workflow)),
      proposalDecisions.get(card.ticket_id) ?? new Map(),
    );
  }

  /** The card with `proposals_pending` as the server sets it (Needs input cards only). */
  function withProposalCount(card: BoardCard): BoardCard {
    const { proposals_pending: _p, ...rest } = card;
    void _p;
    if (card.column !== 'needs_input') return rest;
    const n = proposalsOf(card).filter((p) => p.status === 'pending').length;
    return n > 0 ? { ...rest, proposals_pending: n } : rest;
  }

  /** The proposal, or the 404 the server sends. */
  function proposalOf(ticketId: string, proposalId: string): TicketProposal {
    const card = cards.get(ticketId);
    const p = card ? proposalsOf(card).find((x) => x.id === proposalId) : undefined;
    if (!p) throw new ApiRequestError(404, 'not_found', 'no such proposal on this ticket');
    return p;
  }

  function decide(ticketId: string, proposalId: string, d: ProposalDecision) {
    const m = proposalDecisions.get(ticketId) ?? new Map<string, ProposalDecision>();
    m.set(proposalId, d);
    proposalDecisions.set(ticketId, m);
    const card = cards.get(ticketId)!;
    emit([{ type: 'card.upserted', session_id: card.session_id, ticket_id: ticketId, card }]);
  }

  function cardForSession(sessionId: string): BoardCard {
    for (const card of cards.values()) if (card.session_id === sessionId) return card;
    throw new ApiRequestError(404, 'not_found', `session ${sessionId} not found`);
  }

  /**
   * BoardCard.human_transitions as toBoardCard fills them: only while needs_input in a human
   * state or waiting_external in an event state (none on old versions: no human-actor transitions).
   */
  function humanTransitionsOf(card: BoardCard): BoardCard['human_transitions'] {
    const s = card.session_id ? sessions.get(card.session_id) : undefined;
    const state = card.workflow_state;
    if (!s || state === null) return [];
    const type = s.workflow.states[state]?.type;
    const open =
      (card.status === 'needs_input' && type === 'human') ||
      (card.status === 'waiting_external' && type === 'event');
    return open ? humanTransitionOptions(s.workflow, state, card.kind, s.return_to) : [];
  }

  /** SessionDetail.input_requests (UX-7): the answered ones, then the card's open one. */
  function inputRequestsOf(s: MockSession, card: BoardCard): SessionInputRequest[] {
    const out = [...(s.input_requests ?? [])];
    const open = card.input_request;
    if (open && !out.some((r) => r.id === open.id)) {
      out.push({
        id: open.id,
        kind: open.kind,
        question: open.question,
        created_at: open.created_at,
        answer: null,
        answered_at: null,
        truncated: false,
      });
    }
    return out;
  }

  /** Append a SessionDetail.moves row (state.entered), as the engine records every move. */
  function recordMove(s: MockSession, move: Omit<MoveDto, 'at'>) {
    s.moves.push({ at: now().toISOString(), ...move });
  }

  /** Apply a card change and emit the events EngineService would. */
  /** ADR-0023: `sub_status` / `permission` from the session's pending requests (oldest first). */
  function syncPermissionCard(sessionId: string) {
    const pending = (permissions.get(sessionId) ?? []).filter((r) => r.status === 'pending');
    const rest: BoardCard = { ...cardForSession(sessionId) };
    delete rest.sub_status;
    delete rest.permission;
    const oldest = pending[0];
    update(
      rest,
      oldest
        ? {
            sub_status: 'needs_permission',
            permission: {
              request_id: oldest.id,
              tool: oldest.tool,
              summary: oldest.summary,
              expires_at: oldest.expires_at,
              pending_count: pending.length,
            },
          }
        : {},
    );
  }

  /** 06 §Queue order: the queued (still waiting) tickets, in pickup order. */
  function queuedOrder(): string[] {
    return [...cards.values()]
      .filter(isReorderable)
      .sort(compareQueued)
      .map((c) => c.ticket_id);
  }

  /** Set queue positions (no `updated_at` bump, as the server) and upsert the changed cards. */
  function setQueuePositions(positions: ReadonlyMap<string, number | null>) {
    const drafts: BoardSseEventDraft[] = [];
    for (const [id, pos] of positions) {
      const card = cards.get(id);
      if (!card || (card.queue_position ?? null) === pos) continue;
      const updated: BoardCard = { ...card, queue_position: pos };
      cards.set(id, updated);
      drafts.push({
        type: 'card.upserted',
        session_id: card.session_id,
        ticket_id: id,
        card: updated,
      });
    }
    emit(drafts);
  }

  function update(card: BoardCard, next: Partial<BoardCard>, extra: BoardSseEventDraft[] = []) {
    const sessionId = card.session_id;
    if (sessionId === null) throw new Error('update() needs a session card');
    const updated: BoardCard = { ...card, ...next, updated_at: now().toISOString() };
    updated.column = columnOf(updated);
    updated.human_transitions = humanTransitionsOf(updated);
    cards.set(card.ticket_id, updated);
    const drafts: BoardSseEventDraft[] = [...extra];
    if (card.status !== null && updated.status !== null && card.status !== updated.status) {
      drafts.push({
        type: 'session.status',
        session_id: sessionId,
        from: card.status,
        to: updated.status,
        workflow_state: updated.workflow_state,
      });
    }
    if (card.column !== updated.column) {
      drafts.push({
        type: 'card.moved',
        session_id: sessionId,
        ticket_id: card.ticket_id,
        from: card.column,
        to: updated.column,
      });
    }
    drafts.push({
      type: 'card.upserted',
      session_id: sessionId,
      ticket_id: card.ticket_id,
      card: updated,
    });
    emit(drafts);
  }

  function sessionOf(sessionId: string): MockSession {
    const s = sessions.get(sessionId);
    if (!s) throw new ApiRequestError(404, 'not_found', `session ${sessionId} not found`);
    return s;
  }

  function enterState(session: MockSession, state: string): SessionStatus {
    session.state_entered_at = now().toISOString();
    const type = session.workflow.states[state]?.type;
    if (type === 'terminal') return 'done';
    if (type === 'human') return 'needs_input';
    if (type === 'event') return 'waiting_external';
    return 'running';
  }

  /** The ticket behind a card (seeded from the card and its session on first read). */
  function ticketOf(ticketId: string): TicketDto & { updated_at: string } {
    const card = cards.get(ticketId);
    if (!card) throw new ApiRequestError(404, 'not_found', `ticket ${ticketId} not found`);
    let t = tickets.get(ticketId);
    if (!t) {
      const s = card.session_id ? sessions.get(card.session_id) : undefined;
      t = {
        id: ticketId,
        external_ref: card.external_ref,
        repo: card.repo,
        title: card.title,
        body: s?.ticket_body ?? '',
        workflow_id: card.workflow_id,
        workflow_version: s?.workflow.version ?? null,
        required_tags: [],
        repo_allow_machines: null,
        status: ticketStatusOf(card),
        priority: card.priority,
        created_at: card.created_at,
        kind: card.kind,
        base: card.base,
        updated_at: card.created_at,
      };
      tickets.set(ticketId, t);
    }
    return t;
  }

  /** GET /api/tickets/:id as the orchestrator builds it (`ticketEditable` for the card's column). */
  function ticketDetail(ticketId: string): TicketDetail {
    const t = ticketOf(ticketId);
    const card = cards.get(ticketId)!;
    const s = card.session_id ? sessions.get(card.session_id) : undefined;
    const def = s?.workflow ?? workflows.get(CONDUCTOR.id)?.at(-1)?.definition ?? null;
    return clone({
      ...t,
      title: card.title,
      priority: card.priority,
      kind: card.kind,
      base: card.base,
      base_ref: card.base_ref,
      session_id: card.session_id,
      workflow_state: card.workflow_state,
      column: card.column,
      column_title: COLUMNS.find((c) => c.id === card.column)?.title ?? card.column,
      editable: ticketEditable(def, card.workflow_state),
      proposals: proposalsOf(card),
      attachments: attachmentsOf(ticketId),
      skip_permissions: skipPermissions.get(ticketId) ?? null,
      machine_skip_permissions_default: machineSkipDefault(card.machine_id),
    });
  }

  /** ADR-0039: the default of the card's machine; null = no machine. */
  function machineSkipDefault(machineId: string | null): boolean | null {
    if (machineId === null) return null;
    return machines.get(machineId)?.skip_permissions_default ?? null;
  }

  /** A session-less ticket's status and its card: Queued, or the terminal column cancelled. */
  function setSessionlessStatus(ticketId: string, status: 'ready' | 'cancelled') {
    const t = ticketOf(ticketId);
    const at = new Date(Math.max(now().getTime(), Date.parse(t.updated_at) + 1)).toISOString();
    Object.assign(t, { status, updated_at: at });
    const card = cards.get(ticketId)!;
    const place = placeCard(status, null, { columns: COLUMNS, def: null });
    const next: BoardCard = { ...card, column: place.column, badges: place.badges, updated_at: at };
    cards.set(ticketId, next);
    emit([{ type: 'card.upserted', session_id: null, ticket_id: ticketId, card: next }]);
  }

  const api: MockApi = {
    getBoard: () =>
      reply((): BoardResponse => {
        const columns = COLUMNS.map((c) => ({ ...c, cards: [] as BoardCard[] }));
        for (const card of cards.values()) {
          (columns.find((c) => c.id === card.column) ?? columns[0]!).cards.push(
            clone(withProposalCount(card)),
          );
        }
        // The client re-sorts; the server pre-sorts (06). Order here is insertion order.
        return { columns, last_event_id: nextEventId - 1 };
      }),

    streamBoard(lastEventId, handlers) {
      let open = true;
      boardSubs.add(handlers);
      const backlog = log.filter((e) => e.id > lastEventId);
      queueMicrotask(() => {
        if (open) for (const ev of backlog) handlers.onEvent(clone(ev));
      });
      return () => {
        open = false;
        boardSubs.delete(handlers);
      };
    },

    getSession: (sessionId) =>
      reply((): SessionDetail => {
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        return clone({
          card: withProposalCount(card),
          workflow: s.workflow,
          workflow_version: s.workflow.version,
          context: s.context,
          retry_counters: {},
          state_visits: {},
          return_to: s.return_to,
          state_entered_at: s.state_entered_at,
          state_deadline: null,
          spend_usd: card.spend_usd,
          wall_seconds: s.wall_seconds,
          budget: { usd: s.workflow.budget.usd, minutes: s.workflow.budget.minutes },
          branch: s.branch,
          worktree_path: null,
          pending_input: card.input_request,
          recent_output: s.output,
          moves: s.moves,
          ...(s.ticket_body !== undefined ? { ticket_body: s.ticket_body } : {}),
          input_requests: inputRequestsOf(s, card),
          ticket_editable: ticketEditable(s.workflow, card.workflow_state),
          proposals: proposalsOf(card),
        });
      }),

    streamOutput(sessionId, handlers) {
      let subs = outputSubs.get(sessionId);
      if (!subs) outputSubs.set(sessionId, (subs = new Set()));
      subs.add(handlers);
      return () => {
        subs.delete(handlers);
      };
    },

    answer: (sessionId, raw) =>
      reply((): OkResponse => {
        const parsed = AnswerInputRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const req = parsed.data;
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        if (answered.has(req.input_request_id)) {
          throw new ApiRequestError(409, 'input_already_answered', 'already answered');
        }
        if (card.input_request?.id !== req.input_request_id) {
          throw new ApiRequestError(409, 'input_not_pending', 'no such pending input request');
        }
        const target = req.goto ?? s.return_to ?? s.workflow.start;
        if (!(target in s.workflow.states)) {
          throw new ApiRequestError(400, 'bad_request', `unknown state "${target}"`);
        }
        answered.add(req.input_request_id);
        const open = card.input_request;
        (s.input_requests ??= []).push({
          id: open.id,
          kind: open.kind,
          question: open.question,
          created_at: open.created_at,
          answer: req.answer,
          answered_at: now().toISOString(),
          truncated: false,
        });
        const status = enterState(s, target);
        recordMove(s, {
          from: card.workflow_state,
          to: target,
          transition: null,
          reason: null,
          actor: 'human',
        });
        s.return_to = null;
        update(card, { status, workflow_state: target, input_request: null }, [
          {
            type: 'input.answered',
            session_id: sessionId,
            input_request_id: req.input_request_id,
            answered_by: 'ben',
          },
        ]);
        return { ok: true };
      }),

    createTicket: (raw) =>
      reply((): TicketDto => {
        // ADR-0010: the server defaults `workflow_id` to the one workflow (also before the shared
        // contract does).
        const parsed = CreateTicketRequestSchema.safeParse(
          Object.assign({ workflow_id: CONDUCTOR.id }, raw),
        );
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const req = parsed.data;
        if (!workflows.has(req.workflow_id)) {
          throw new ApiRequestError(400, 'bad_request', `unknown workflow "${req.workflow_id}"`);
        }
        if (req.base !== undefined) refuseBase(req.base, req.workflow_id);
        return addTicket(req);
      }),

    searchTickets: (o = {}) =>
      reply((): TicketSearchResponse => {
        const q = o.q?.trim().toLowerCase() ?? '';
        const hex = q.replace(/-/g, '');
        const byId = /^[0-9a-f]{4,32}$/.test(hex);
        const groups = o.status ?? ['all'];
        const wanted = (s: TicketStatus) =>
          groups.includes('all') || groups.includes(ticketSearchGroup(s));
        const found = [...cards.values()]
          .map((card) => ({ card, t: ticketOf(card.ticket_id) }))
          .map(({ card, t }) => ({ card, t: { ...t, status: ticketStatusOf(card) } }))
          .filter(({ t }) => wanted(t.status))
          .filter(
            ({ card, t }) =>
              q === '' ||
              card.title.toLowerCase().includes(q) ||
              (card.external_ref ?? '').toLowerCase().includes(q) ||
              t.body.toLowerCase().includes(q) ||
              (byId && t.id.replace(/-/g, '').startsWith(hex)),
          )
          .sort(
            (a, b) =>
              b.card.updated_at.localeCompare(a.card.updated_at) || a.t.id.localeCompare(b.t.id),
          );
        const cursor = o.cursor ?? 0;
        const page = found.slice(cursor, cursor + (o.limit ?? 20));
        const end = cursor + page.length;
        return clone({
          tickets: page.map(({ card, t }): TicketSearchResult => ({
            id: t.id,
            title: card.title,
            external_ref: card.external_ref,
            status: t.status,
            kind: card.kind,
            repo: card.repo,
            snippet: q === '' ? null : mockSnippet(t.body, q),
            session_id: card.session_id,
            created_at: card.created_at,
            updated_at: card.updated_at,
          })),
          next_cursor: end < found.length ? end : null,
          total: found.length,
        });
      }),

    getTicket: (ticketId) => reply(() => ticketDetail(ticketId)),

    uploadAttachment: (file) =>
      reply((): AttachmentDto => {
        const problem = attachmentProblem(file);
        if (problem !== null) {
          throw new ApiRequestError(
            /too large/.test(problem) ? 413 : 415,
            /too large/.test(problem) ? 'attachment_too_large' : 'attachment_type',
            problem,
          );
        }
        const mime = file.type as AttachmentDto['mime'];
        const id = crypto.randomUUID();
        const dto: AttachmentDto = {
          id,
          name: sanitizeAttachmentName(file.name, mime),
          mime,
          size_bytes: file.size,
          source: 'human',
          caption: null,
          session_id: null,
          workflow_state: null,
          created_at: now().toISOString(),
          url: API_PATHS.attachmentContent(id),
        };
        // jsdom has no createObjectURL; the dev mock (a browser) does.
        const src = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : dto.url;
        attachments.set(id, { dto, ticketId: null, src });
        return clone(dto);
      }),

    deleteAttachment: (attachmentId) =>
      reply(() => {
        const a = attachments.get(attachmentId);
        if (!a) throw new ApiRequestError(404, 'not_found', `attachment ${attachmentId} not found`);
        if (a.ticketId !== null) {
          throw new ApiRequestError(409, 'conflict', 'the attachment is on a ticket');
        }
        attachments.delete(attachmentId);
        return { ok: true as const };
      }),

    attachmentUrl: (a) => attachments.get(a.id)?.src ?? a.url,

    async approveProposal(ticketId, raw) {
      const parsed = ApproveProposalRequestSchema.safeParse(raw);
      if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
      const req = parsed.data;
      const p = await reply(() => proposalOf(ticketId, req.proposal_id));
      if (p.status === 'dismissed') {
        throw new ApiRequestError(409, 'conflict', 'the proposal was dismissed');
      }
      if (p.status === 'approved' && p.created_ticket_id !== null) {
        return { proposal: p, ticket: clone(ticketOf(p.created_ticket_id)) };
      }
      const parent = ticketOf(ticketId);
      const ticket = await api.createTicket({
        title: req.title ?? p.title,
        body: req.body ?? proposalTicketBody(p, parent),
        repo: p.repo,
        workflow_id: parent.workflow_id,
        kind: parent.kind ?? 'work',
      });
      decide(ticketId, p.id, { status: 'approved', created_ticket_id: ticket.id });
      return { proposal: { ...p, status: 'approved', created_ticket_id: ticket.id }, ticket };
    },

    dismissProposal: (ticketId, raw) =>
      reply((): TicketProposal => {
        const parsed = DismissProposalRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const p = proposalOf(ticketId, parsed.data.proposal_id);
        if (p.status === 'approved') {
          throw new ApiRequestError(409, 'conflict', 'the proposal was approved');
        }
        if (p.status === 'pending') {
          decide(ticketId, p.id, { status: 'dismissed', created_ticket_id: null });
        }
        return { ...p, status: 'dismissed' };
      }),

    sharePage: (pageId) =>
      reply(() => ({ share_url: `${location.origin}/p/${pageId}?t=mock-share-token` })),

    reorderQueue: (ticketIds) =>
      reply((): QueueOrderResponse => {
        const parsed = ReorderQueueRequestSchema.safeParse({ ticket_ids: ticketIds });
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const current = queuedOrder();
        const ready = new Set(current);
        const first = parsed.data.ticket_ids.filter((id) => ready.has(id));
        if (first.length === 0) {
          throw new ApiRequestError(404, 'not_found', 'none of ticket_ids is a queued ticket');
        }
        const order = [...first, ...current.filter((id) => !first.includes(id))];
        setQueuePositions(new Map(order.map((id, i) => [id, i + 1])));
        return {
          ticket_ids: queuedOrder(),
          skipped: parsed.data.ticket_ids.filter((id) => !ready.has(id)),
        };
      }),

    resetQueueOrder: () =>
      reply((): QueueOrderResponse => {
        setQueuePositions(new Map(queuedOrder().map((id) => [id, null])));
        return { ticket_ids: queuedOrder(), skipped: [] };
      }),

    updateTicket: (ticketId, raw) =>
      reply((): TicketDetail => {
        const parsed = UpdateTicketRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const req = parsed.data;
        const before = ticketDetail(ticketId);
        if (!before.editable) {
          throw new ApiRequestError(
            403,
            'ticket_not_editable',
            `the ${before.column_title} column does not allow editing the ticket`,
          );
        }
        const t = ticketOf(ticketId);
        if (Date.parse(req.expected_updated_at) !== Date.parse(t.updated_at)) {
          throw new ApiRequestError(409, 'conflict', 'the ticket changed since it was loaded');
        }
        // ADR-0039: the base is fixed once a session starts.
        if (req.base !== undefined && before.column !== 'queued') {
          throw new ApiRequestError(
            403,
            'ticket_not_editable',
            'the base is fixed once the ticket has started',
          );
        }
        if (req.base != null) refuseBase(req.base, t.workflow_id);
        for (const id of req.remove_attachment_ids ?? []) {
          if (attachments.get(id)?.ticketId === ticketId) attachments.delete(id);
        }
        linkUploads(ticketId, req.add_attachment_ids ?? []);
        // Strictly later than before, so a second edit from the old version is a conflict.
        const at = new Date(Math.max(now().getTime(), Date.parse(t.updated_at) + 1)).toISOString();
        Object.assign(t, {
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.body !== undefined ? { body: req.body } : {}),
          ...(req.priority !== undefined ? { priority: req.priority } : {}),
          ...(req.kind !== undefined ? { kind: req.kind } : {}),
          ...(req.base !== undefined ? { base: req.base } : {}),
          updated_at: at,
        });
        const s = before.session_id ? sessions.get(before.session_id) : undefined;
        if (s && req.body !== undefined) s.ticket_body = req.body;
        const card = cards.get(ticketId)!;
        const next = {
          title: t.title,
          priority: t.priority,
          kind: t.kind ?? null,
          base: t.base ?? null,
        };
        if (card.session_id !== null) {
          update(card, next);
        } else {
          const updated: BoardCard = { ...card, ...next, updated_at: at };
          cards.set(ticketId, updated);
          emit([{ type: 'card.upserted', session_id: null, ticket_id: ticketId, card: updated }]);
        }
        return ticketDetail(ticketId);
      }),

    // ADR-0039: like the route, any column; turning it on allows the pending prompts.
    setSkipPermissions: (ticketId, raw) =>
      reply((): TicketDetail => {
        const parsed = SetSkipPermissionsRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        ticketOf(ticketId);
        skipPermissions.set(ticketId, parsed.data.skip_permissions);
        const card = cards.get(ticketId)!;
        const on = effectiveSkipPermissions(
          parsed.data.skip_permissions,
          machineSkipDefault(card.machine_id),
        );
        const list = card.session_id ? permissions.get(card.session_id) : undefined;
        if (on && list && card.session_id) {
          list.forEach((r, i) => {
            if (r.status !== 'pending') return;
            list[i] = {
              ...r,
              status: 'allowed',
              decision: {
                behavior: 'allow',
                scope: 'once',
                message: 'skip permissions is on for this ticket',
                rule: null,
                decided_by: 'ben',
              },
              resolved_at: now().toISOString(),
            };
          });
          syncPermissionCard(card.session_id);
        }
        return ticketDetail(ticketId);
      }),

    // UXR-86: a card with a session is cancelled as its session; a queued one as the ticket.
    cancelTicket: (ticketId, req) => {
      const card = cards.get(ticketId);
      if (card?.session_id) {
        return api.cancel(card.session_id, req?.reason !== undefined ? { reason: req.reason } : {});
      }
      return reply((): OkResponse => {
        const t = ticketOf(ticketId);
        if (t.status !== 'ready') {
          throw new ApiRequestError(409, 'conflict', `the ticket is ${t.status}, not ready`);
        }
        setSessionlessStatus(ticketId, 'cancelled');
        return { ok: true };
      });
    },

    reopenTicket: (ticketId, req) => {
      const card = cards.get(ticketId);
      if (card?.session_id) {
        return api
          .reopen(card.session_id, { text: req?.text ?? 'Reopened from the board.' })
          .then(() => ({ ok: true as const }));
      }
      return reply((): OkResponse => {
        const t = ticketOf(ticketId);
        if (t.status !== 'cancelled') {
          throw new ApiRequestError(409, 'conflict', `the ticket is ${t.status}, not cancelled`);
        }
        setSessionlessStatus(ticketId, 'ready');
        return { ok: true };
      });
    },

    listRepoChecks: () =>
      reply(() => ({
        repos: clone([...repoChecks.values()].sort((a, b) => a.repo.localeCompare(b.repo))),
      })),

    getRepoChecks: (repo) =>
      reply((): RepoChecksDetail => {
        const key = repoChecksKey(repo);
        if (key === '' || key.length > 200) {
          throw new ApiRequestError(400, 'bad_request', 'repo must be 1..200 chars');
        }
        const override = repoChecks.get(key) ?? null;
        const def = workflows.get(CONDUCTOR.id)?.at(-1)?.definition ?? CONDUCTOR;
        return clone({
          repo: key,
          override,
          effective: checksGatesOf(def).map((g) =>
            override !== null
              ? { at: g.at, source: 'override', setup: override.setup, checks: override.checks }
              : { at: g.at, source: 'workflow', setup: g.setup, checks: [...g.checks] },
          ),
        });
      }),

    getRepoCheckRuns: (repo, limit = 5) =>
      reply((): RepoCheckRunsResponse => {
        const key = repoChecksKey(repo);
        if (key === '' || key.length > 200) {
          throw new ApiRequestError(400, 'bad_request', 'repo must be 1..200 chars');
        }
        const override = repoChecks.get(key) ?? null;
        const def = workflows.get(CONDUCTOR.id)?.at(-1)?.definition ?? CONDUCTOR;
        const checks = override?.checks ?? checksGatesOf(def).flatMap((g) => g.checks);
        const rows = checkRuns.filter((r) => repoChecksKey(r.repo) === key);
        const titles = new Map(rows.map((r) => [r.ticket_id, `Ticket ${r.ticket_id.slice(-2)}`]));
        return clone({
          repo: key,
          window_days: 30,
          checks: runsByCheck(checks, rows, limit, titles),
        });
      }),

    getRepoChecksHealth: () =>
      reply((): RepoChecksHealthResponse => ({ window_days: 30, repos: repoHealth(checkRuns) })),

    setRepoChecks: (raw) =>
      reply((): RepoChecksDto => {
        const fail = (issues: { path: PropertyKey[]; message: string }[]) =>
          new ApiRequestError(
            400,
            'bad_request',
            'invalid repo checks',
            issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
          );
        const req = PutRepoChecksRequestSchema.safeParse(raw);
        if (!req.success) throw fail(req.error.issues);
        const checked = RepoChecksSchema.safeParse({
          ...(req.data.setup !== undefined ? { setup: req.data.setup } : {}),
          checks: req.data.checks,
        });
        if (!checked.success) throw fail(checked.error.issues);
        const dto: RepoChecksDto = {
          repo: repoChecksKey(req.data.repo),
          setup: checked.data.setup ?? null,
          checks: checked.data.checks,
          updated_at: now().toISOString(),
          updated_by: MOCK_ADMIN.email,
        };
        repoChecks.set(dto.repo, dto);
        return clone(dto);
      }),

    clearRepoChecks: (repo) =>
      reply((): OkResponse => {
        const key = repoChecksKey(repo);
        if (!repoChecks.delete(key)) {
          throw new ApiRequestError(404, 'not_found', `no repo checks for ${key}`);
        }
        return { ok: true };
      }),

    listSchedules: () =>
      reply(() => ({
        schedules: [...schedules.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(scheduleView),
      })),

    saveSchedule: (id, raw) =>
      reply((): ScheduleDto => {
        const at = now().toISOString();
        if (id === null) {
          const parsed = CreateScheduleRequestSchema.safeParse(raw);
          if (!parsed.success) throw zodBadRequest(parsed.error.issues);
          const req = parsed.data;
          checkScheduleRule(req.cron, req.timezone);
          const machineIds = resolveScheduleMachines(req.machines);
          scheduleNameTaken(req.name, null);
          const sc: ScheduleDto = {
            id: crypto.randomUUID(),
            name: req.name,
            cron: req.cron,
            timezone: req.timezone,
            enabled: req.enabled,
            title: req.title,
            body: req.body,
            repo: req.repo,
            workflow_id: req.workflow_id,
            kind: req.kind,
            priority: req.priority,
            required_tags: req.required_tags,
            machine_ids: machineIds,
            next_run_at: req.enabled
              ? (nextRunAfter(req.cron, req.timezone, now())?.toISOString() ?? null)
              : null,
            next_runs: [],
            last_run_at: null,
            last_ticket: null,
            last_skipped_at: null,
            last_skip_reason: null,
            created_by: MOCK_ADMIN.email,
            created_at: at,
            updated_at: at,
          };
          schedules.set(sc.id, sc);
          return scheduleView(sc);
        }
        const parsed = UpdateScheduleRequestSchema.safeParse(raw);
        if (!parsed.success) throw zodBadRequest(parsed.error.issues);
        const patch = parsed.data;
        const cur = scheduleOf(id);
        if (
          patch.expected_updated_at !== undefined &&
          Date.parse(patch.expected_updated_at) !== Date.parse(cur.updated_at)
        ) {
          throw new ApiRequestError(
            409,
            'conflict',
            'the schedule changed since you read it: read it again',
          );
        }
        const machineIds =
          patch.machines === undefined ? cur.machine_ids : resolveScheduleMachines(patch.machines);
        const cron = patch.cron ?? cur.cron;
        const timezone = patch.timezone ?? cur.timezone;
        const enabled = patch.enabled ?? cur.enabled;
        const ruleChanged = cron !== cur.cron || timezone !== cur.timezone;
        if (ruleChanged || (enabled && !cur.enabled)) checkScheduleRule(cron, timezone);
        if (patch.name !== undefined) scheduleNameTaken(patch.name, id);
        const next_run_at = !enabled
          ? null
          : ruleChanged || !cur.enabled || cur.next_run_at === null
            ? (nextRunAfter(cron, timezone, now())?.toISOString() ?? null)
            : cur.next_run_at;
        const sc: ScheduleDto = {
          ...cur,
          name: patch.name ?? cur.name,
          title: patch.title ?? cur.title,
          body: patch.body ?? cur.body,
          repo: patch.repo ?? cur.repo,
          workflow_id: patch.workflow_id ?? cur.workflow_id,
          kind: patch.kind ?? cur.kind,
          priority: patch.priority ?? cur.priority,
          required_tags: patch.required_tags ?? cur.required_tags,
          cron,
          timezone,
          enabled,
          machine_ids: machineIds,
          next_run_at,
          updated_at: bumpedAt(cur.updated_at),
        };
        schedules.set(id, sc);
        return scheduleView(sc);
      }),

    deleteSchedule: (id) =>
      reply((): OkResponse => {
        if (!schedules.delete(id)) throw new ApiRequestError(404, 'not_found', `no schedule ${id}`);
        return { ok: true };
      }),

    runScheduleNow: (id, o = {}) =>
      reply(() => {
        const sc = scheduleOf(id);
        const open = sc.last_ticket ? ticketStatusById(sc.last_ticket.id) : null;
        if (open !== null && ['ready', 'claimed', 'in_progress'].includes(open) && !o.force) {
          throw new ApiRequestError(
            409,
            'previous_run_open',
            'the last run of this schedule is still open; finish it first, or pass force',
          );
        }
        const at = now();
        const ticket = addTicket(
          CreateTicketRequestSchema.parse({
            title: `${sc.title} ${formatScheduleTime(at, sc.timezone)}`,
            body: sc.body,
            repo: sc.repo,
            workflow_id: CONDUCTOR.id,
            priority: sc.priority,
            kind: sc.kind,
            required_tags: sc.required_tags,
            repo_allow_machines: sc.machine_ids,
          }),
          { id: sc.id, name: sc.name },
        );
        const next: ScheduleDto = {
          ...sc,
          last_run_at: at.toISOString(),
          last_ticket: { id: ticket.id, status: 'ready' },
        };
        schedules.set(id, next);
        return { ticket_id: ticket.id, schedule: scheduleView(next) };
      }),

    listChangeProposals: (o = {}) =>
      reply((): ChangeProposalListResponse => {
        const wanted = o.status === undefined || o.status === 'all' ? null : o.status;
        const target = o.target === undefined ? null : repoChecksKey(o.target);
        const all = proposals.filter(
          (p) =>
            (wanted === null || p.status === wanted) &&
            (o.kind === undefined || p.kind === o.kind) &&
            (o.ticketId === undefined || p.ticket_id === o.ticketId) &&
            (target === null || p.target === o.target || p.target === target),
        );
        const cursor = o.cursor ?? 0;
        const page = all.slice(cursor, cursor + 10);
        const end = cursor + page.length;
        return clone({
          proposals: page.map(summaryOf),
          next_cursor: end < all.length ? end : null,
          total: all.length,
        });
      }),

    getChangeProposal: (id) => reply(() => clone(proposal(id))),

    getProcessMetrics: (o) => reply(() => clone(insights.metrics(o.windowDays, o.groupBy))),

    listFindings: (o) => reply(() => clone(insights.findings(o.windowDays, o.cursor ?? 0))),

    getProcessReport: (o) => reply(() => clone(insights.report(o.windowDays))),

    getSessionInsight: (sessionId) =>
      reply(() => {
        const found = insights.insight(sessionId);
        if (found === null)
          throw new ApiRequestError(404, 'not_found', 'no insight for that session');
        return clone(found);
      }),

    applyChangeProposal: (id) =>
      reply((): ChangeProposalDetail => {
        const p = proposal(id);
        mustBeProposed(p);
        if (p.requires_admin && authMode !== 'local' && !signedInUser().row.is_admin) {
          throw new ApiRequestError(403, 'forbidden', 'Only an instance admin can apply this.');
        }
        const at = now().toISOString();
        // A workflow change saves its definition as the next version, like the server.
        let applied: number | null = null;
        if (p.kind === 'workflow' && p.proposed_definition) {
          const versions = workflows.get(p.target) ?? [];
          applied = versions.length + 1;
          versions.push({
            definition: clone({ ...p.proposed_definition, version: applied }),
            created_at: at,
            created_by: MOCK_ADMIN.email,
            note: `Applied proposal: ${p.title}`,
          });
          workflows.set(p.target, versions);
        }
        Object.assign(p, {
          status: 'applied',
          applied_at: at,
          decided_at: at,
          decided_by: MOCK_ADMIN.email,
          ...(applied !== null ? { applied_version: applied } : {}),
        });
        return clone(p);
      }),

    rejectChangeProposal: (id) =>
      reply((): ChangeProposalDetail => {
        const p = proposal(id);
        mustBeProposed(p);
        Object.assign(p, { status: 'rejected', decided_at: now().toISOString() });
        return clone(p);
      }),

    reviewChangeProposal: (id) =>
      reply((): ChangeProposalDetail => {
        const p = proposal(id);
        if (p.status !== 'applied') {
          throw new ApiRequestError(409, 'wrong_state', 'Only an applied proposal is reviewed.');
        }
        return clone(p);
      }),

    listRepos: () =>
      reply(() =>
        rankRepos(
          [...cards.values()],
          [...machines.values()].flatMap((mc) =>
            mc.revoked_at === null
              ? mc.repos.flatMap((r) => (r.remote === null ? [] : [r.remote]))
              : [],
          ),
          now(),
        ),
      ),

    listWorkflows: () =>
      reply((): WorkflowSummary[] =>
        [...workflows.entries()].map(([id, versions]) => {
          const latest = versions[versions.length - 1]!;
          return {
            id,
            version: versions.length,
            start: latest.definition.start,
            state_count: Object.keys(latest.definition.states).length,
            created_at: latest.created_at,
          };
        }),
      ),

    getWorkflow: (id, version) =>
      reply((): WorkflowDetail => {
        const versions = workflows.get(id);
        const row = versions?.[(version ?? versions.length) - 1];
        if (!row) {
          throw new ApiRequestError(
            404,
            'not_found',
            version === undefined
              ? `workflow ${id} not found`
              : `workflow ${id} v${version} not found`,
          );
        }
        // `versions`: every saved version (the optional WorkflowDetail field, ADR-0009).
        const out: WorkflowDetail = {
          id,
          version: row.definition.version,
          created_at: row.created_at,
          created_by: row.created_by,
          note: row.note,
          definition: row.definition,
          versions: (versions ?? []).map((v) => v.definition.version),
          default_available: defaultAvailable(id),
          // UXR-70: the version history.
          history: (versions ?? []).map((v) => ({
            version: v.definition.version,
            created_at: v.created_at,
            created_by: v.created_by,
            note: v.note,
          })),
        };
        return clone(out);
      }),

    saveWorkflow: (definition, opts) =>
      reply(() => {
        // The orchestrator's validator (T03), plus the ADR-0009 gate and ADR-0010 entry rules.
        // The base-refs scene treats `bases` as available (ADR-0039), as B2 will.
        const result = validateWorkflow(definition, basesScene ? { allowUnavailable: true } : {});
        const details = result.ok
          ? validateColumns(
              result.def,
              basesScene ? [...AVAILABLE_WORKFLOW_FEATURES, 'bases'] : AVAILABLE_WORKFLOW_FEATURES,
            ).map(({ path, message }) => ({ path, message }))
          : result.errors.map((e) => ({
              path: e.path.join('.'),
              message: `rule ${e.rule}: ${e.message}`,
            }));
        if (!result.ok || details.length > 0) {
          throw new ApiRequestError(
            400,
            'invalid_workflow',
            'workflow definition is invalid',
            details,
          );
        }
        const versions = workflows.get(result.def.id) ?? [];
        const version = versions.length + 1;
        versions.push({
          definition: clone({ ...result.def, version }),
          created_at: now().toISOString(),
          created_by: MOCK_ADMIN.email,
          note: opts?.note?.trim() ? opts.note.trim() : null,
        });
        workflows.set(result.def.id, versions);
        const warnings = (result.warnings ?? []).map((w) => ({
          path: w.path.join('.'),
          message: `rule ${w.rule}: ${w.message}`,
        }));
        return { id: result.def.id, version, ...(warnings.length > 0 ? { warnings } : {}) };
      }),

    getWorkflowDefault: (id) =>
      reply((): WorkflowDefaultResponse => {
        const version = defaultAvailable(id);
        const latest = workflows.get(id)?.at(-1)?.definition;
        if (version === null || !opts.defaultWorkflow || !latest) {
          throw new ApiRequestError(404, 'not_found', `no newer default for ${id}`);
        }
        return clone({
          version,
          base_version: latest.version,
          definition: opts.defaultWorkflow,
          diff: capDiff(diffWorkflow(latest, opts.defaultWorkflow), DIFF_MAX),
        });
      }),

    adoptDefaultWorkflow: (id, baseVersion) =>
      reply((): SaveWorkflowResponse => {
        if (authMode !== 'local' && !signedInUser().row.is_admin) {
          throw new ApiRequestError(
            403,
            'forbidden',
            'only an instance admin can change the workflow',
          );
        }
        const versions = workflows.get(id);
        if (id !== CONDUCTOR.id || !versions || !opts.defaultWorkflow) {
          throw new ApiRequestError(404, 'not_found', `no shipped default for ${id}`);
        }
        const latest = versions.length;
        if (baseVersion !== latest) {
          throw new ApiRequestError(
            409,
            'conflict',
            `${id} changed since version ${baseVersion}: the latest is ${latest}`,
          );
        }
        const version = latest + 1;
        versions.push({
          definition: clone({ ...opts.defaultWorkflow, version }),
          created_at: now().toISOString(),
          created_by: MOCK_ADMIN.email,
          note: `Adopted the default v${opts.defaultWorkflow.version}`,
        });
        return { id, version };
      }),

    approve: (sessionId) =>
      reply((): OkResponse => {
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        const state = card.workflow_state ? s.workflow.states[card.workflow_state] : undefined;
        const next = state?.type === 'event' ? state.on?.['ui.approve'] : undefined;
        if (card.status !== 'waiting_external' || next === undefined) {
          throw new ApiRequestError(409, 'conflict', 'session is not waiting for ui.approve');
        }
        const target = typeof next === 'string' ? next : next.goto;
        recordMove(s, {
          from: card.workflow_state,
          to: target,
          transition: 'ui.approve',
          reason: null,
          actor: 'system',
        });
        update(card, { status: enterState(s, target), workflow_state: target });
        return { ok: true };
      }),

    transition: (sessionId, raw) =>
      reply((): OkResponse => {
        const parsed = TransitionSessionRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const { name, text } = parsed.data;
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        // Like apply(): only a transition the card offers (wrong status, unknown name, not a
        // human transition for the ticket's kind → ignored → 409). The server doesn't re-check
        // `needs_text`, so neither does the mock.
        const option = card.human_transitions.find((o) => o.name === name);
        if (!option) {
          throw new ApiRequestError(409, 'conflict', `transition "${name}" is not offered here`);
        }
        const target = option.goto === RETURN_TO ? (s.return_to ?? s.workflow.start) : option.goto;
        const extra: BoardSseEventDraft[] = card.input_request
          ? [
              {
                type: 'input.answered',
                session_id: sessionId,
                input_request_id: card.input_request.id,
                answered_by: 'ben',
              },
            ]
          : [];
        if (card.input_request) answered.add(card.input_request.id);
        recordMove(s, {
          from: card.workflow_state,
          to: target,
          transition: name,
          reason: text ?? null,
          actor: 'human',
        });
        const status = enterState(s, target);
        if (s.workflow.states[target]?.type !== 'human') s.return_to = null;
        update(card, { status, workflow_state: target, input_request: null }, extra);
        return { ok: true };
      }),

    freshConversation: (sessionId, raw) =>
      reply((): OkResponse => {
        const parsed = FreshConversationRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        // Like apply(): only while parked in a human state with an agent state to return to.
        const state = card.workflow_state ? s.workflow.states[card.workflow_state] : undefined;
        const target = s.return_to;
        if (
          card.status !== 'needs_input' ||
          state?.type !== 'human' ||
          target === null ||
          s.workflow.states[target]?.type !== 'agent'
        ) {
          throw new ApiRequestError(
            409,
            'conflict',
            'the session is not waiting on a human with an agent to return to',
          );
        }
        const extra: BoardSseEventDraft[] = card.input_request
          ? [
              {
                type: 'input.answered',
                session_id: sessionId,
                input_request_id: card.input_request.id,
                answered_by: 'ben',
              },
            ]
          : [];
        if (card.input_request) answered.add(card.input_request.id);
        recordMove(s, {
          from: card.workflow_state,
          to: target,
          transition: FRESH_CONVERSATION_MOVE,
          reason: parsed.data.text,
          actor: 'human',
        });
        const status = enterState(s, target);
        s.return_to = null;
        update(card, { status, workflow_state: target, input_request: null }, extra);
        return { ok: true };
      }),

    listPermissionRequests: (sessionId) =>
      reply(() => {
        cardForSession(sessionId);
        return { requests: [...(permissions.get(sessionId) ?? [])] };
      }),

    decidePermission: (requestId, raw) =>
      reply((): PermissionRequestDto => {
        const parsed = PermissionDecisionRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const { behavior, scope, message } = parsed.data;
        const list = [...permissions.values()].find((l) => l.some((r) => r.id === requestId));
        const i = list?.findIndex((r) => r.id === requestId) ?? -1;
        const req = list?.[i];
        if (!list || !req) {
          throw new ApiRequestError(404, 'not_found', `permission request ${requestId} not found`);
        }
        // Like the route: the same decision again is idempotent; anything else on a decided or
        // expired request is 409.
        if (req.status !== 'pending') {
          if (req.decision?.behavior === behavior && req.decision.scope === scope) return req;
          throw new ApiRequestError(
            409,
            'permission_not_pending',
            'permission request not pending',
          );
        }
        if (scope === 'always' && req.always_rule === null) {
          throw new ApiRequestError(400, 'bad_request', 'this request has no exact rule');
        }
        const decided: PermissionRequestDto = {
          ...req,
          status: behavior === 'allow' ? 'allowed' : 'denied',
          decision: {
            behavior,
            scope,
            message: message ?? null,
            rule: scope === 'always' ? req.always_rule : null,
            decided_by: 'ben',
          },
          resolved_at: now().toISOString(),
        };
        list[i] = decided;
        syncPermissionCard(req.session_id);
        return decided;
      }),

    cancel: (sessionId) =>
      reply((): OkResponse => {
        const card = cardForSession(sessionId);
        if (card.status === null || TERMINAL.has(card.status)) {
          throw new ApiRequestError(409, 'conflict', 'session already finished');
        }
        const extra: BoardSseEventDraft[] = card.input_request
          ? [
              {
                type: 'input.answered',
                session_id: sessionId,
                input_request_id: card.input_request.id,
                answered_by: null,
              },
            ]
          : [];
        update(card, { status: 'failed', input_request: null }, extra);
        return { ok: true };
      }),

    sendMessage: (sessionId, raw) =>
      reply((): OkResponse => {
        const parsed = SendMessageRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const card = cardForSession(sessionId);
        const s = sessionOf(sessionId);
        const state = card.workflow_state ? s.workflow.states[card.workflow_state] : undefined;
        if (card.status !== 'running' || state?.type !== 'agent') {
          throw new ApiRequestError(409, 'conflict', 'session has no live agent process');
        }
        const text = parsed.data.text;
        api.pushOutput(sessionId, text, 'user');
        // A pretend agent, so `pnpm dev` with the mock answers back.
        setTimeout(() => {
          if (sessions.has(sessionId)) api.pushOutput(sessionId, fakeReply(text));
        }, replyDelay);
        return { ok: true };
      }),

    listMachines: () => reply(() => [...machines.keys()].map(machineRow)),
    listTeam: () =>
      reply(() => {
        const minAgo = (min: number) => new Date(now().getTime() - min * 60_000).toISOString();
        const ended = new Set<string | null>(['done', 'failed', 'lost', 'cancelled']);
        return TeamResponseSchema.parse(
          MOCK_TEAM.map((m) => ({
            name: m.name,
            hired_at: minAgo(m.hiredDaysAgo * 1440),
            last_assigned_at: m.lastAssignedMinAgo === null ? null : minAgo(m.lastAssignedMinAgo),
            active_ticket_id:
              [...cards.values()].find((c) => c.agent_name === m.name && !ended.has(c.status))
                ?.ticket_id ?? null,
          })),
        );
      }),

    getTranscript: (sessionId) =>
      reply((): TranscriptResponse => {
        const s = sessionOf(sessionId);
        if (!s.transcript) {
          throw new ApiRequestError(404, 'no_transcript', 'machine mbp-ben has no transcript');
        }
        return clone({ machine_id: 'mbp-ben', chunks: s.transcript, truncated: false });
      }),

    reopen: (sessionId, raw) =>
      reply((): ReopenSessionResponse => {
        const parsed = ReopenSessionRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(400, 'bad_request', parsed.error.message);
        const s = sessionOf(sessionId);
        const card = [...cards.values()].find((c) => c.session_id === sessionId);
        if (!card) throw new ApiRequestError(409, 'conflict', 'not the ticket’s latest session');
        if (card.status !== 'done' && card.status !== 'failed') {
          throw new ApiRequestError(409, 'conflict', `the session is ${card.status ?? 'queued'}`);
        }
        // Like the orchestrator after the claim: a new running session for the same ticket, at
        // the workflow's start state, with the same branch and context (ADR-0008).
        const id = crypto.randomUUID();
        const start = s.workflow.start;
        sessions.set(id, {
          ...clone(s),
          return_to: null,
          state_entered_at: now().toISOString(),
          wall_seconds: 0,
          output: [],
          moves: [],
        });
        const next: BoardCard = {
          ...card,
          session_id: id,
          status: 'running',
          workflow_state: start,
          column: start,
          input_request: null,
          spend_usd: 0,
          updated_at: now().toISOString(),
        };
        cards.set(card.ticket_id, next);
        emit([
          {
            type: 'card.moved',
            session_id: id,
            ticket_id: card.ticket_id,
            from: card.column,
            to: next.column,
          },
          { type: 'card.upserted', session_id: id, ticket_id: card.ticket_id, card: next },
        ]);
        const text = parsed.data.text;
        api.pushOutput(id, text, 'user');
        setTimeout(() => {
          if (sessions.has(id)) api.pushOutput(id, fakeReply(text));
        }, replyDelay);
        return { session_id: id };
      }),

    me: () =>
      reply((): MeResponse => (authMode === 'local' ? localMeResponse() : meFor(signedInUser()))),

    login: (raw) =>
      reply((): MeResponse => {
        const parsed = LoginRequestSchema.safeParse(raw);
        if (!parsed.success) throw new ApiRequestError(401, 'unauthorized', INVALID_CREDENTIALS);
        const user = [...users.values()].find((u) => u.row.email === parsed.data.email);
        if (
          !user ||
          user.password !== parsed.data.password ||
          user.row.disabled_at !== null ||
          user.row.locked
        ) {
          throw new ApiRequestError(401, 'unauthorized', INVALID_CREDENTIALS);
        }
        session = user.row.id;
        return meFor(user);
      }),

    logout: () =>
      reply((): OkResponse => {
        session = null;
        return { ok: true };
      }),

    signup: (raw) =>
      reply((): MeResponse => {
        const parsed = SignupRequestSchema.safeParse(raw);
        if (!parsed.success) {
          throw badRequest(
            parsed.error.message,
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        }
        const req = parsed.data;
        const invite = invites.get(req.invite);
        if (!inviteOpen(invite)) throw badRequest('This invite is not valid');
        if (invite.email !== null && invite.email !== req.email) {
          throw badRequest('This invite is for another email address');
        }
        if ([...users.values()].some((u) => u.row.email === req.email)) {
          throw badRequest('An account with this email already exists');
        }
        const row: AdminUserRow = {
          id: crypto.randomUUID(),
          email: req.email,
          display_name: req.display_name,
          is_admin: invite.is_admin,
          disabled_at: null,
          created_at: now().toISOString(),
          locked: false,
        };
        const user = { row, password: req.password };
        users.set(row.id, user);
        invite.used_at = now().toISOString();
        session = row.id;
        return meFor(user);
      }),

    previewInvite: (token) =>
      reply(() => {
        const invite = invites.get(token);
        if (!inviteOpen(invite)) return { valid: false, expires_at: null };
        return {
          valid: true,
          ...(invite.email !== null ? { email: invite.email } : {}),
          expires_at: invite.expires_at,
        };
      }),

    resetPassword: (raw) =>
      reply((): OkResponse => {
        const parsed = ResetRequestSchema.safeParse(raw);
        if (!parsed.success) throw badRequest(parsed.error.message);
        const reset = resets.get(parsed.data.token);
        if (!reset || reset.used || Date.parse(reset.expires_at) <= now().getTime()) {
          throw badRequest('This reset link is not valid');
        }
        const user = userById(reset.userId);
        const bad = passwordError(parsed.data.password, user.row.email);
        if (bad) throw bad;
        user.password = parsed.data.password;
        reset.used = true;
        if (session === user.row.id) session = null;
        return { ok: true };
      }),

    changePassword: (raw) =>
      reply((): OkResponse => {
        const parsed = PasswordChangeRequestSchema.safeParse(raw);
        if (!parsed.success) throw badRequest(parsed.error.message);
        const user = signedInUser();
        if (user.password !== parsed.data.current) {
          const message = 'Your current password is wrong.';
          throw badRequest(message, [{ path: 'current', message }]);
        }
        const bad = passwordError(parsed.data.new, user.row.email);
        if (bad) throw bad;
        user.password = parsed.data.new;
        return { ok: true };
      }),

    listInvites: () =>
      reply((): InviteRow[] => {
        requireAdmin();
        return clone([...invites.values()].reverse());
      }),

    createInvite: (raw) =>
      reply(() => {
        requireAdmin();
        const parsed = CreateInviteRequestSchema.safeParse(raw);
        if (!parsed.success) throw badRequest(parsed.error.message);
        const token = `mock-${++issued}-${crypto.randomUUID().slice(0, 8)}`;
        const row: InviteRow = {
          id: crypto.randomUUID(),
          email: parsed.data.email ?? null,
          is_admin: parsed.data.admin ?? false,
          created_at: now().toISOString(),
          expires_at: isoIn((parsed.data.days ?? INVITE_DEFAULT_DAYS) * day),
          used_at: null,
          revoked_at: null,
        };
        invites.set(token, row);
        return {
          id: row.id,
          url: `http://localhost/signup?invite=${token}`,
          expires_at: row.expires_at,
        };
      }),

    revokeInvite: (inviteId) =>
      reply((): OkResponse => {
        requireAdmin();
        const row = [...invites.values()].find((r) => r.id === inviteId);
        if (!row) throw new ApiRequestError(404, 'not_found', `invite ${inviteId} not found`);
        row.revoked_at ??= now().toISOString();
        return { ok: true };
      }),

    listUsers: () =>
      reply((): AdminUserRow[] => {
        requireAdmin();
        return clone([...users.values()].map((u) => u.row));
      }),

    createResetLink: (userId) =>
      reply(() => {
        requireAdmin();
        userById(userId);
        const token = `mock-reset-${++issued}`;
        const expires_at = isoIn(RESET_LINK_TTL_MS);
        resets.set(token, { userId, expires_at, used: false });
        return { url: `http://localhost/reset?token=${token}`, expires_at };
      }),

    disableUser: (userId) =>
      reply((): OkResponse => {
        requireAdmin();
        const user = userById(userId);
        user.row.disabled_at ??= now().toISOString();
        if (session === userId) session = null;
        return { ok: true };
      }),

    unlockUser: (userId) =>
      reply((): OkResponse => {
        requireAdmin();
        userById(userId).row.locked = false;
        return { ok: true };
      }),

    getMachine: (machineId) => reply(() => machineOf(machineId)),

    renameMachine: (machineId, raw) =>
      reply((): MachineRow => {
        const m = machines.get(machineId);
        if (!m) throw new ApiRequestError(404, 'not_found', `machine ${machineId} not found`);
        const parsed = RenameMachineRequestSchema.safeParse(raw);
        if (!parsed.success) throw badRequest(parsed.error.message);
        m.name = parsed.data.name;
        return machineRow(machineId);
      }),

    updateMachineRules: (machineId, raw) =>
      reply((): MachineRow => {
        const m = machines.get(machineId);
        if (!m) throw new ApiRequestError(404, 'not_found', `machine ${machineId} not found`);
        const parsed = UpdateMachineRequestSchema.safeParse(raw);
        if (!parsed.success) throw badRequest(parsed.error.message);
        const { name, repo_allow, repo_exclusive, skip_permissions_default } = parsed.data;
        if (repo_exclusive !== undefined) {
          for (const o of machines.values()) {
            if (o.id === machineId || o.revoked_at !== null) continue;
            const theirs = new Set(o.repo_exclusive.map((p) => p.toLowerCase()));
            const clash = repo_exclusive.find((p) => theirs.has(p.toLowerCase()));
            if (clash !== undefined) {
              throw new ApiRequestError(
                409,
                'conflict',
                `${clash} is already exclusive to ${o.name}`,
              );
            }
          }
          m.repo_exclusive = repo_exclusive;
        }
        if (name !== undefined) m.name = name;
        if (repo_allow !== undefined) m.repo_allow = repo_allow;
        if (skip_permissions_default !== undefined) {
          m.skip_permissions_default = skip_permissions_default;
        }
        return machineRow(machineId);
      }),

    revokeMachine: (machineId) =>
      reply((): OkResponse => {
        const m = machines.get(machineId);
        if (!m) throw new ApiRequestError(404, 'not_found', `machine ${machineId} not found`);
        m.revoked_at ??= now().toISOString();
        m.status = 'offline';
        // As the server: a revoked machine gets no upgrade command (stopgap until ADR-0021).
        m.upgrade_command = null;
        m.upgrade_command_windows = null;
        return { ok: true };
      }),

    createEnrollmentToken: () =>
      reply((): EnrollmentTokenCreated => {
        const token = `mock-enroll-${++issued}`;
        return {
          token,
          command: `curl -fsSL http://localhost/install.sh | sh -s -- --token ${token}`,
          command_windows: `$env:CONDUCTOR_ENROLL_TOKEN='${token}'; irm http://localhost/install.ps1 | iex`,
          expires_at: isoIn(ENROLLMENT_TOKEN_TTL_MS),
        };
      }),

    // UX-16: the mock is a server without VAPID, so the push toggle stays hidden.
    pushVapidPublicKey: () => reply(pushDisabled),
    pushSubscribe: () => reply(pushDisabled),
    pushUnsubscribe: () => reply(pushDisabled),
    pushTest: () => reply(pushDisabled),

    connectMachine(patch = {}) {
      const id = `mock-machine-${++connected}`;
      const base = mockMachines(now())[0]!;
      machines.set(id, {
        ...base,
        id,
        name: `new-machine-${connected}`,
        hostname: `new-machine-${connected}.local`,
        status: 'online',
        last_heartbeat_at: now().toISOString(),
        alerts: [],
        ...patch,
      });
      return id;
    },

    updateMachine(id, patch) {
      const m = machines.get(id);
      if (!m) throw new Error(`no machine ${id}`);
      machines.set(id, { ...m, ...patch });
    },

    lockUser(email) {
      for (const u of users.values()) if (u.row.email === email) u.row.locked = true;
    },

    pushOutput(sessionId, text, stream = 'assistant') {
      const s = sessionOf(sessionId);
      const chunk: OutputChunk = {
        session_id: sessionId,
        seq: (s.output.at(-1)?.seq ?? -1) + 1,
        stream,
        text,
        ts: now().toISOString(),
      };
      s.output.push(chunk);
      for (const sub of outputSubs.get(sessionId) ?? []) sub.onEvent(clone(chunk));
    },

    requestInput(sessionId, kind, question) {
      const card = cardForSession(sessionId);
      const s = sessionOf(sessionId);
      const id = crypto.randomUUID();
      const created_at = now().toISOString();
      s.return_to = card.workflow_state;
      recordMove(s, {
        from: card.workflow_state,
        to: 'needs_input',
        transition: 'ask_user',
        reason: question,
        actor: 'agent',
      });
      update(
        card,
        {
          status: 'needs_input',
          workflow_state: 'needs_input',
          input_request: {
            id,
            session_id: sessionId,
            kind,
            question,
            created_at,
            answer: null,
            answered_by: null,
            answered_at: null,
          },
        },
        [
          {
            type: 'input.requested',
            session_id: sessionId,
            input_request_id: id,
            kind,
            question,
            created_at,
          },
        ],
      );
      return id;
    },

    updateCard(sessionId, next) {
      update(cardForSession(sessionId), next);
    },

    requestPermission(sessionId, tool, input, alwaysRule = null) {
      const id = crypto.randomUUID();
      const created = now();
      const list = permissions.get(sessionId) ?? [];
      list.push({
        id,
        session_id: sessionId,
        tool,
        input: input as PermissionRequestDto['input'],
        suggestions: [],
        summary: permissionSummary(input),
        always_rule: alwaysRule,
        status: 'pending',
        decision: null,
        expired_reason: null,
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + 30 * 60_000).toISOString(),
        resolved_at: null,
      });
      permissions.set(sessionId, list);
      syncPermissionCard(sessionId);
      return id;
    },

    simulate(ms) {
      let n = 0;
      const timer = setInterval(() => {
        for (const card of cards.values()) {
          if (card.status === 'running' && card.session_id) {
            api.pushOutput(card.session_id, `[${card.workflow_state ?? '?'}] step ${++n}\n`);
          }
        }
      }, ms);
      return () => clearInterval(timer);
    },
  };
  return api;
}

function fakeReply(text: string): string {
  const cmd = /^\/(\S+)/.exec(text)?.[1];
  if (cmd === 'context') {
    return '**Context usage** · 41k / 200k tokens (21%)\n\n- System prompt: 3.1k\n- Tools: 11.8k\n- Messages: 26.4k';
  }
  if (cmd === 'compact') return 'Compacted the conversation. Carrying on with the summary.';
  if (cmd) return `Unknown command \`/${cmd}\`.`;
  return "Got it. I'll take that into account and keep going.";
}
