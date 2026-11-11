import {
  RETURN_TO,
  transitionActor,
  transitionTitle,
  type NotifyMode,
  type NotifyPolicy,
  type TransitionActor,
  type TransitionObject,
  type WorkflowDefinition,
} from '@conductor/shared';
import { columnTitle } from './columns.js';
import { getTransitionObject, patchTransition, transitionNames } from './transitions.js';

// ADR-0037 P6 (T4) in the designer: a transition's notify select and the workflow's notify policy.

/**
 * ADR-0037 P6: a transition's notify choice. `''` = inherit (absent): the workflow default under a
 * policy, no notification of its own in legacy mode.
 */
export type NotifyChoice = '' | NotifyMode;

export const NOTIFY_MODE_TEXT: Record<NotifyMode, string> = {
  once: 'Once per ticket',
  every: 'Every time',
  never: 'Never',
};

export const NOTIFY_CHOICES: readonly { value: NotifyChoice; text: string }[] = [
  { value: '', text: 'Inherit' },
  { value: 'once', text: NOTIFY_MODE_TEXT.once },
  { value: 'every', text: NOTIFY_MODE_TEXT.every },
  { value: 'never', text: NOTIFY_MODE_TEXT.never },
];
/** Without a workflow notify policy only the legacy boolean means anything (rule 23). */
export const LEGACY_NOTIFY_CHOICES: readonly { value: NotifyChoice; text: string }[] = [
  { value: '', text: 'Inherit (no notification of its own)' },
  { value: 'every', text: NOTIFY_MODE_TEXT.every },
  { value: 'never', text: NOTIFY_MODE_TEXT.never },
];

/** The stored value as a choice: legacy `true` reads as every, `false` as never. */
export function notifyChoice(notify: TransitionObject['notify']): NotifyChoice {
  if (notify === undefined || notify === 'inherit') return '';
  if (notify === true) return 'every';
  if (notify === false) return 'never';
  return notify;
}

/** What a choice stores: a mode under a policy, the legacy boolean without one. */
export function notifyValue(choice: NotifyChoice, policy: boolean): TransitionObject['notify'] {
  if (choice === '') return undefined;
  if (policy) return choice;
  return choice === 'every' ? true : choice === 'never' ? false : undefined;
}

/** The policy a new block starts with: once per transition, engine moves silent. */
export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = { default: 'once', engine_moves: 'never' };

/**
 * Add, change or remove (`null`) the workflow's notify policy. Removing it turns string notify
 * values back into the legacy boolean (`every` → true, `never` → false, the rest absent), so the
 * definition stays valid (rule 23).
 */
export function setNotifyPolicy(
  def: WorkflowDefinition,
  policy: NotifyPolicy | null,
): WorkflowDefinition {
  if (policy !== null) return { ...def, notify: policy };
  const { notify: _drop, ...rest } = def;
  void _drop;
  const states: WorkflowDefinition['states'] = {};
  for (const [name, state] of Object.entries(def.states)) {
    if (state.type === 'terminal' || state.on === undefined) {
      states[name] = state;
      continue;
    }
    const on: NonNullable<typeof state.on> = {};
    for (const [tn, t] of Object.entries(state.on)) {
      if (typeof t !== 'object' || typeof t.notify !== 'string') {
        on[tn] = t;
        continue;
      }
      const { notify, ...other } = t;
      const legacy = notify === 'every' ? true : notify === 'never' ? false : undefined;
      on[tn] = legacy === undefined ? other : { ...other, notify: legacy };
    }
    states[name] = { ...state, on };
  }
  return { ...rest, states };
}

/**
 * The notify select's options for this definition: every mode under a policy (Inherit names the
 * workflow default), only the legacy boolean's choices without one (rule 23).
 */
export function notifyOptions(def: WorkflowDefinition): { value: NotifyChoice; text: string }[] {
  const policy = def.notify;
  if (policy === undefined) return [...LEGACY_NOTIFY_CHOICES];
  return NOTIFY_CHOICES.map(({ value, text }) => ({
    value,
    text: value === '' ? `${text} (${NOTIFY_MODE_TEXT[policy.default].toLowerCase()})` : text,
  }));
}

/** One row of the Notifications section's per-transition table. */
export interface NotifyRow {
  from: string;
  name: string;
  title: string;
  fromTitle: string;
  toTitle: string;
  actor: TransitionActor;
  choice: NotifyChoice;
}

/** Every transition of the workflow, by column then definition order, with its notify choice. */
export function notifyRows(def: WorkflowDefinition): NotifyRow[] {
  const rows: NotifyRow[] = [];
  for (const [from, state] of Object.entries(def.states)) {
    if (state.type === 'terminal') continue;
    for (const name of transitionNames(def, from)) {
      const raw = state.on?.[name];
      const t = getTransitionObject(def, from, name);
      if (raw === undefined || t === null) continue;
      rows.push({
        from,
        name,
        title: transitionTitle(name, raw),
        fromTitle: columnTitle(def, from),
        toTitle: t.goto === RETURN_TO ? 'The column that asked' : columnTitle(def, t.goto),
        actor: transitionActor(def, from, name, raw),
        choice: notifyChoice(t.notify),
      });
    }
  }
  return rows;
}

/** How a choice reads in a count: the workflow default for Inherit, legacy Inherit is never. */
export function effectiveMode(def: WorkflowDefinition, choice: NotifyChoice): NotifyMode {
  if (choice !== '') return choice;
  return def.notify?.default ?? 'never';
}

/** Set transition `name` out of `from` to `choice` (a mode under a policy, else the boolean). */
export function setTransitionNotify(
  def: WorkflowDefinition,
  from: string,
  name: string,
  choice: NotifyChoice,
): WorkflowDefinition {
  return patchTransition(def, from, name, {
    notify: notifyValue(choice, def.notify !== undefined),
  });
}
