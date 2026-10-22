import { health } from '@conductor/shared';

export function App() {
  const h = health('@conductor/web');
  return (
    <main>
      <h1>Conductor</h1>
      <p>
        {h.package} ok: {String(h.ok)}
      </p>
    </main>
  );
}
