import type { StructuralChange } from '@conductor/shared';

// ADR-0033 P3: a structural workflow diff (shared `diffWorkflow`) as a table, path by path. Shown
// by a change proposal (ProposalsPanel) and by the newer-default Compare (UXR-87, DefaultBanner).

const show = (v: unknown): string =>
  v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);

export function DiffTable({ changes, more }: { changes: StructuralChange[]; more: number }) {
  return (
    <table className="cp-diff">
      <thead>
        <tr>
          <th scope="col">Change</th>
          <th scope="col">Where</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={`${c.op}:${c.path}`} className={`cp-op-${c.op}`}>
            <td>{c.op}</td>
            <td>
              <code>{c.path}</code>
            </td>
            <td>
              <code>{show(c.before)}</code>
            </td>
            <td>
              <code>{show(c.after)}</code>
            </td>
          </tr>
        ))}
        {more > 0 && (
          <tr>
            <td colSpan={4} className="muted">
              …and {more} more
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
