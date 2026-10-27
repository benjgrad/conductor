import type { MachineCapabilityDto, MachineDetail } from '@conductor/shared';
import { ago } from '../components/format.js';
import { ghTooOld, ghTooOldText, shortRepo } from './format.js';

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
}

/** One machine's inventory (ADR-0013 §Inventory): repos, capabilities by kind, open alerts. */
export function MachineDrawer({ machine, onClose }: MachineDrawerProps) {
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
