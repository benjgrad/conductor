// Test-only: a `matchMedia` that answers width queries for a chosen viewport. jsdom has no
// `matchMedia`, so without this every component renders its desktop layout.

type Listener = (e: { matches: boolean; media: string }) => void;

export interface MockViewport {
  /** Resize: the queries whose answer changes fire their `change` listeners. */
  resize: (width: number) => void;
  /** Removes the stub (put `matchMedia` back as it was). */
  restore: () => void;
}

/** Answers `(max-width: Npx)` and `(min-width: Npx)`; anything else (e.g. `pointer`) is false. */
function evaluate(query: string, width: number): boolean {
  const max = /max-width:\s*([\d.]+)px/.exec(query);
  if (max) return width <= Number(max[1]);
  const min = /min-width:\s*([\d.]+)px/.exec(query);
  if (min) return width >= Number(min[1]);
  return false;
}

export function mockViewport(width: number): MockViewport {
  let current = width;
  const lists: { query: string; listeners: Set<Listener>; last: boolean }[] = [];
  const before = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const entry = { query, listeners: new Set<Listener>(), last: evaluate(query, current) };
      lists.push(entry);
      return {
        get matches() {
          return evaluate(query, current);
        },
        media: query,
        onchange: null,
        addEventListener: (_: 'change', l: Listener) => entry.listeners.add(l),
        removeEventListener: (_: 'change', l: Listener) => entry.listeners.delete(l),
        addListener: (l: Listener) => entry.listeners.add(l),
        removeListener: (l: Listener) => entry.listeners.delete(l),
        dispatchEvent: () => false,
      };
    },
  });
  return {
    resize(next) {
      current = next;
      for (const entry of lists) {
        const matches = evaluate(entry.query, current);
        if (matches === entry.last) continue;
        entry.last = matches;
        for (const l of entry.listeners) l({ matches, media: entry.query });
      }
    },
    restore() {
      if (before) Object.defineProperty(window, 'matchMedia', before);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    },
  };
}
