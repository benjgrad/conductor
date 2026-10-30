import { describe, expect, it } from 'vitest';
import { API_PATHS, TicketDetailSchema, UpdateTicketRequestSchema } from '../api/rest.js';
import { ticketEditable } from './editable.js';
import { CONDUCTOR_V2_DEF } from './conductor.js';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './schema.js';

const def = (over: Partial<WorkflowDefinition> = {}, states = {}): WorkflowDefinition =>
  WorkflowDefinitionSchema.parse({
    id: 'w',
    version: 1,
    start: 'work',
    budget: { usd: 1, minutes: 10, max_loop_retries: 1 },
    states: {
      work: { type: 'agent', prompt: 'ticket_template', on: { done: 'ask' } },
      ask: { type: 'human' },
      done: { type: 'terminal' },
      ...states,
    },
    ...over,
  });

describe('ticketEditable', () => {
  it('defaults: Queued and human columns yes, every other type no', () => {
    const d = def();
    expect(ticketEditable(d, null)).toBe(true);
    expect(ticketEditable(d, 'ask')).toBe(true);
    expect(ticketEditable(d, 'work')).toBe(false);
    expect(ticketEditable(d, 'done')).toBe(false);
  });

  it('the flags override the defaults', () => {
    const d = def(
      { queued_ticket_editable: false },
      {
        work: {
          type: 'agent',
          prompt: 'ticket_template',
          ticket_editable: true,
          on: { done: 'ask' },
        },
        ask: { type: 'human', ticket_editable: false },
      },
    );
    expect(ticketEditable(d, null)).toBe(false);
    expect(ticketEditable(d, 'work')).toBe(true);
    expect(ticketEditable(d, 'ask')).toBe(false);
  });

  it('an unknown state or definition is read-only; Queued without one is editable', () => {
    expect(ticketEditable(def(), 'gone')).toBe(false);
    expect(ticketEditable(null, 'ask')).toBe(false);
    expect(ticketEditable(null, null)).toBe(true);
  });

  it('the shipped workflow still parses (the flags are optional)', () => {
    expect(WorkflowDefinitionSchema.safeParse(CONDUCTOR_V2_DEF).success).toBe(true);
  });
});

describe('ticket edit contracts', () => {
  const at = '2026-10-30T12:00:00.000Z';

  it('has the path', () => {
    expect(API_PATHS.ticket(':id')).toBe('/api/tickets/:id');
  });

  it('UpdateTicketRequest needs a change and a non-blank title', () => {
    expect(UpdateTicketRequestSchema.safeParse({ expected_updated_at: at }).success).toBe(false);
    expect(
      UpdateTicketRequestSchema.safeParse({ expected_updated_at: at, title: '  ' }).success,
    ).toBe(false);
    expect(UpdateTicketRequestSchema.parse({ expected_updated_at: at, title: ' T ' }).title).toBe(
      'T',
    );
    expect(UpdateTicketRequestSchema.safeParse({ title: 'T' }).success).toBe(false);
  });

  it('TicketDetail parses', () => {
    expect(
      TicketDetailSchema.safeParse({
        id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
        external_ref: null,
        repo: 'github.com/o/r',
        title: 'T',
        body: '',
        workflow_id: 'conductor',
        workflow_version: null,
        required_tags: [],
        repo_allow_machines: null,
        status: 'ready',
        priority: 0,
        created_at: at,
        updated_at: at,
        session_id: null,
        workflow_state: null,
        column: 'queued',
        column_title: 'Queued',
        editable: true,
      }).success,
    ).toBe(true);
  });
});
