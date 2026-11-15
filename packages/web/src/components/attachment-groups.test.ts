import type { AttachmentDto } from '@conductor/shared';
import { describe, expect, it } from 'vitest';
import {
  groupByState,
  matchChatFiles,
  sessionCaptures,
  splitAttachments,
  splitChatFiles,
  splitHumanByOrigin,
} from './attachment-groups.js';

const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';

function att(
  id: string,
  source: 'human' | 'agent',
  at: string,
  state: string | null = null,
  session: string | null = null,
): AttachmentDto {
  return {
    id,
    name: `${id}.gif`,
    mime: 'image/gif',
    size_bytes: 1,
    source,
    caption: null,
    session_id: session,
    workflow_state: state,
    created_at: at,
    url: `/api/attachments/${id}/content`,
  };
}

const list = [
  att('mock', 'human', '2026-11-01T00:00:00.000Z'),
  att('before', 'agent', '2026-11-02T00:00:00.000Z', 'implementing', S1),
  att('plan', 'agent', '2026-11-01T12:00:00.000Z', 'planning', S1),
  att('after', 'agent', '2026-11-02T01:00:00.000Z', 'implementing', S2),
];

describe('attachment groups', () => {
  it('splits the human attachments from the agents', () => {
    const { human, agent } = splitAttachments(list);
    expect(human.map((a) => a.id)).toEqual(['mock']);
    expect(agent.map((a) => a.id)).toEqual(['before', 'plan', 'after']);
  });

  it('groups agent captures by state, the latest group first, files in upload order', () => {
    const groups = groupByState(splitAttachments(list).agent);
    expect(groups.map((g) => [g.state, g.items.map((a) => a.id)])).toEqual([
      ['implementing', ['before', 'after']],
      ['planning', ['plan']],
    ]);
    expect(groupByState([])).toEqual([]);
  });

  it("picks one session's captures", () => {
    expect(sessionCaptures(list, S1).map((a) => a.id)).toEqual(['before', 'plan']);
    expect(sessionCaptures(list, null)).toEqual([]);
  });
});

describe('chat attachments (06 §Attachments, chat)', () => {
  it("splitHumanByOrigin: the ticket's own files apart from those sent in a chat", () => {
    const own = att('own', 'human', '2026-11-01T00:00:00.000Z');
    const chat = att('chat', 'human', '2026-11-02T00:00:00.000Z', 'implementing', S1);
    expect(splitHumanByOrigin([own, chat])).toEqual({ original: [own], chat: [chat] });
  });

  it('splitChatFiles takes the trailing paperclip lines only', () => {
    expect(splitChatFiles('Look\n\u{1F4CE} a.png\n\u{1F4CE} b c.png')).toEqual({
      text: 'Look',
      names: ['a.png', 'b c.png'],
    });
    expect(splitChatFiles('\u{1F4CE} a.png')).toEqual({ text: '', names: ['a.png'] });
    const mid = '\u{1F4CE} not a file\nthen text';
    expect(splitChatFiles(mid)).toEqual({ text: mid, names: [] });
  });

  it('matchChatFiles uses each file once, in order; null where none matches', () => {
    const a1 = { ...att('a1', 'human', '2026-11-01T00:00:00.000Z', null, S1), name: 'a.png' };
    const a2 = { ...att('a2', 'human', '2026-11-02T00:00:00.000Z', null, S2), name: 'a.png' };
    expect(matchChatFiles(['a.png', 'a.png', 'x.png'], [a1, a2])).toEqual([a1, a2, null]);
  });
});
