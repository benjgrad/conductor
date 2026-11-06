// @vitest-environment jsdom
// ADR-0023 (M2-T29d): the "Needs permission" box in the session panel and the card badge.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from '../api/mock-data.js';
import { createMockApi } from '../api/mock.js';
import { DetailPanel } from './DetailPanel.js';
import { NEEDS_PERMISSION_LABEL, PermissionInput } from './PermissionRequests.js';

afterEach(cleanup);

const SID = SEED_IDS.running.session;

async function open(
  ask: (api: ReturnType<typeof createMockApi>) => void = (api) =>
    api.requestPermission(
      SID,
      'Bash',
      { command: 'pnpm vitest run', description: 'Run the tests' },
      'Bash(pnpm vitest run)',
    ),
) {
  const api = createMockApi({ replyDelayMs: 0 });
  ask(api);
  const decide = vi.spyOn(api, 'decidePermission');
  render(<DetailPanel api={api} sessionId={SID} version="1" onClose={() => undefined} />);
  const el = await screen.findByRole('complementary', { name: 'Session detail' });
  const box = await within(el).findByRole('region', { name: NEEDS_PERMISSION_LABEL });
  await within(box).findByRole('group', { name: 'Bash request' });
  return { api, decide, panel: within(el), box: within(box) };
}

describe('PermissionRequests (ADR-0023)', () => {
  it('shows the tool, the command as code and its description', async () => {
    const { box } = await open();
    expect(box.getByText(NEEDS_PERMISSION_LABEL, { selector: '.request-chip' })).toBeTruthy();
    // UXR-35: violet, not the red of a failure, and no "Action needed" caps.
    expect(document.querySelector('section.request-permission')).toBeTruthy();
    expect(box.queryByText(/Action needed/i)).toBeNull();
    expect(box.getByText('pnpm vitest run', { selector: 'code' })).toBeTruthy();
    expect(box.getByText('Run the tests')).toBeTruthy();
  });

  it('Allow once posts {allow, once} and the box goes away', async () => {
    const { box, decide, panel } = await open();
    fireEvent.click(box.getByRole('button', { name: 'Allow once' }));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(expect.any(String), { behavior: 'allow', scope: 'once' }),
    );
    await waitFor(() =>
      expect(panel.queryByRole('region', { name: NEEDS_PERMISSION_LABEL })).toBeNull(),
    );
  });

  it('Allow always posts {allow, always} and names the rule it records', async () => {
    const { box, decide } = await open();
    const always = box.getByRole('button', { name: 'Allow always' });
    expect(always.getAttribute('title')).toContain('Bash(pnpm vitest run)');
    fireEvent.click(always);
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(expect.any(String), {
        behavior: 'allow',
        scope: 'always',
      }),
    );
  });

  it('ADR-0039: "Skip permissions for this ticket" asks, then allows what is pending', async () => {
    const { api, box, panel } = await open();
    const skip = vi.spyOn(api, 'setSkipPermissions');
    fireEvent.click(box.getByRole('button', { name: 'Skip permissions for this ticket…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Skip permissions for this ticket?' });
    expect(within(dialog).getByText(/git push stays denied/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip permissions' }));
    await waitFor(() =>
      expect(skip).toHaveBeenCalledWith(SEED_IDS.running.ticket, { skip_permissions: true }),
    );
    await waitFor(() =>
      expect(panel.queryByRole('region', { name: NEEDS_PERMISSION_LABEL })).toBeNull(),
    );
    const { requests } = await api.listPermissionRequests(SID);
    expect(requests.map((r) => r.status)).toEqual(['allowed']);
  });

  it('ADR-0039: cancelling the confirmation changes nothing', async () => {
    const { api, box } = await open();
    const skip = vi.spyOn(api, 'setSkipPermissions');
    fireEvent.click(box.getByRole('button', { name: 'Skip permissions for this ticket…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Skip permissions for this ticket?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(skip).not.toHaveBeenCalled();
    expect(box.getByRole('group', { name: 'Bash request' })).toBeTruthy();
  });

  it('hides Allow always when the request has no exact rule', async () => {
    const { box } = await open((api) =>
      api.requestPermission(SID, 'Bash', { command: 'rm -rf build/*' }, null),
    );
    expect(box.getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(box.queryByRole('button', { name: 'Allow always' })).toBeNull();
  });

  it('Deny… takes an optional note', async () => {
    const { box, decide } = await open();
    fireEvent.click(box.getByRole('button', { name: 'Deny…' }));
    fireEvent.change(box.getByLabelText('Note for the agent (optional)'), {
      target: { value: '  use pnpm test instead ' },
    });
    fireEvent.click(box.getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(expect.any(String), {
        behavior: 'deny',
        scope: 'once',
        message: 'use pnpm test instead',
      }),
    );
  });

  it('a deny without a note sends no message', async () => {
    const { box, decide } = await open();
    fireEvent.click(box.getByRole('button', { name: 'Deny…' }));
    fireEvent.click(box.getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(expect.any(String), { behavior: 'deny', scope: 'once' }),
    );
  });

  it('lists every pending request, oldest first', async () => {
    const { box } = await open((api) => {
      api.requestPermission(SID, 'Bash', { command: 'pnpm vitest run' }, 'Bash(pnpm vitest run)');
      api.requestPermission(SID, 'WebFetch', { url: 'https://example.com/a' }, null);
    });
    await box.findByRole('group', { name: 'WebFetch request' });
    const groups = box.getAllByRole('group', { name: /request$/ });
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Bash request',
      'WebFetch request',
    ]);
    expect(box.getByText(/\(\+1 more\)/)).toBeTruthy();
  });
});

describe('PermissionInput', () => {
  it('shows non-Bash input as JSON', () => {
    render(<PermissionInput tool="Write" input={{ file_path: '/w/a.md', content: 'hi' }} />);
    expect(screen.getByRole('region', { name: 'Tool input' }).textContent).toContain(
      '"file_path": "/w/a.md"',
    );
  });

  it('collapses long input behind Show all', () => {
    const command = Array.from({ length: 40 }, (_, i) => `echo ${i}`).join('\n');
    render(<PermissionInput tool="Bash" input={{ command }} />);
    const region = screen.getByRole('region', { name: 'Tool input' });
    expect(region.querySelector('.permission-code.clamped')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(region.querySelector('.permission-code.clamped')).toBeNull();
  });
});
