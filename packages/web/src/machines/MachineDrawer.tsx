import {
  RepoRuleListSchema,
  type MachineCapabilityDto,
  type MachineDetail,
  type UpdateMachineRequest,
} from '@conductor/shared';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '../api/client.js';
import { ago } from '../components/format.js';
import { cannotTakeReasons, ghTooOld, ghTooOldText, shortRepo } from './format.js';

const KINDS: { key: keyof MachineDetail['capabilities']; title: string }[] = [
  { key: 'cli', title: 'CLIs' },
  { key: 'mcp', title: 'MCP servers' },
  { key: 'skill', title: 'Skills' },
  { key: 'agent', title: 'Agents' },
  { key: 'claude', title: 'Claude' },
];

interface MachineDrawerProps {
  machine: MachineDetail;
  onClose: () => void;
  /** Saves the repo rules (PATCH /api/machines/:id); rejects with the API error. */
  onSaveRules: (req: UpdateMachineRequest) => Promise<unknown>;
}

/**
 * One machine's inventory (ADR-0013 §Inventory): repos, capabilities by kind, open alerts, its repo
 * rules (amendment 2026-10-30), and the queued tickets it can't take (M2-T16a).
 */
export function MachineDrawer({ machine, onClose, onSaveRules }: MachineDrawerProps) {
  const oldGh = ghTooOld(machine.capabilities);
  return (
    <aside className="machine-drawer" role="dialog" aria-label={`Machine ${machine.name}`}>
      <header>
        <h3>{machine.name}</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="machine-sub">
        {machine.hostname}
        {machine.os && ` · ${machine.os}`}
        {machine.arch && `/${machine.arch}`}
      </p>
      {oldGh !== null && <p className="machine-warning">⚠ {ghTooOldText(oldGh)}</p>}

      <section aria-label="Open alerts">
        <h4>Open alerts</h4>
        {machine.alerts.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="machine-alerts">
            {machine.alerts.map((a) => (
              <li key={a.id}>
                <span className="badge badge-alert">.git changed</span>{' '}
                {a.repo && <code>{shortRepo(a.repo)}</code>} {ago(a.created_at)}
                <ul>
                  {a.files.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Repos">
        <h4>Repos</h4>
        {machine.repos.length === 0 ? (
          <p className="muted">None found under the daemon's repo roots.</p>
        ) : (
          <table className="machines-table">
            <thead>
              <tr>
                <th>Remote</th>
                <th>Path</th>
                <th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {machine.repos.map((r) => (
                <tr key={r.path}>
                  <td>{r.remote ?? <span className="muted">no remote (not routable)</span>}</td>
                  <td>
                    <code>{r.path}</code>
                  </td>
                  <td>{r.mode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <RepoRules key={machine.id} machine={machine} onSave={onSaveRules} />

      <section aria-label="Capabilities">
        <h4>Capabilities</h4>
        {KINDS.map(({ key, title }) => (
          <div key={key} className="machine-caps">
            <h5>{title}</h5>
            {machine.capabilities[key].length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul aria-label={title}>
                {machine.capabilities[key].map((c) => (
                  <li key={`${c.name}@${c.repo ?? ''}`}>{capabilityText(c)}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <div className="machine-caps">
          <h5>Can't take</h5>
          {machine.cannot_take.length === 0 ? (
            <p className="muted">None: it can take every queued ticket.</p>
          ) : (
            <ul aria-label="Can't take" className="machine-cannot-take">
              {machine.cannot_take.map((t) => (
                <li key={t.ticket_id}>
                  {t.title}: <span className="muted">{cannotTakeReasons(t).join('; ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </aside>
  );
}

function capabilityText(c: MachineCapabilityDto): string {
  const parts = [c.name];
  if (c.version !== null) parts.push(c.version);
  if (c.authed !== null) parts.push(c.authed ? '(signed in)' : '(not signed in)');
  if (c.repo !== null) parts.push(`in ${shortRepo(c.repo)}`);
  return parts.join(' ');
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** A rule list as typed (one pattern per line), validated with the API's schema. */
function parseRules(text: string, label: string): { ok: string[] } | { error: string } {
  const parsed = RepoRuleListSchema.safeParse(lines(text));
  if (parsed.success) return { ok: parsed.data };
  const issue = parsed.error.issues[0];
  const at = typeof issue?.path[0] === 'number' ? lines(text)[issue.path[0]] : undefined;
  return {
    error: `${label}: ${at !== undefined ? `${at} is not` : 'expected'} host/org/repo or host/org/*`,
  };
}

/**
 * The machine's repo rules (ADR-0013 amendment 2026-10-30): the repos it may take (empty = any) and
 * those only it takes, one `host/org/repo` or `host/org/*` per line.
 */
function RepoRules({
  machine,
  onSave,
}: {
  machine: MachineDetail;
  onSave: (req: UpdateMachineRequest) => Promise<unknown>;
}) {
  const [allow, setAllow] = useState((machine.repo_allow ?? []).join('\n'));
  const [exclusive, setExclusive] = useState(machine.repo_exclusive.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const a = parseRules(allow, 'Only take these repos');
    const x = parseRules(exclusive, 'Only this machine takes');
    if ('error' in a) return setError(a.error);
    if ('error' in x) return setError(x.error);
    setError(null);
    setSaving(true);
    try {
      await onSave({ repo_allow: a.ok.length === 0 ? null : a.ok, repo_exclusive: x.ok });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Repo rules">
      <h4>Repo rules</h4>
      <form className="machine-rules" onSubmit={(e) => void submit(e)}>
        <label>
          Only take these repos <span className="muted">(empty: any repo)</span>
          <textarea
            rows={3}
            value={allow}
            placeholder="github.com/org/*"
            onChange={(e) => setAllow(e.target.value)}
          />
        </label>
        <label>
          Only this machine takes{' '}
          <span className="muted">(other machines never start these, even while it's offline)</span>
          <textarea
            rows={3}
            value={exclusive}
            placeholder="github.com/work-org/*"
            onChange={(e) => setExclusive(e.target.value)}
          />
        </label>
        {error !== null && (
          <p className="machine-warning" role="alert">
            {error}
          </p>
        )}
        <div>
          <button type="submit" disabled={saving}>
            Save rules
          </button>
          {saved && <span className="muted"> Saved.</span>}
        </div>
      </form>
    </section>
  );
}
