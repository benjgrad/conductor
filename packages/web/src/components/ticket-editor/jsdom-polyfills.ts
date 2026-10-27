// Test-only: the browser APIs BlockNote / Mantine touch that jsdom lacks. Returns an undo, so a
// test file can scope them (without them the field falls back to its plain textarea).

export function installEditorPolyfills(): () => void {
  const undo: (() => void)[] = [];
  function define<T extends object>(target: T, key: string, value: unknown) {
    if ((target as Record<string, unknown>)[key] != null) return;
    const before = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
    undo.push(() => {
      if (before) Object.defineProperty(target, key, before);
      else delete (target as Record<string, unknown>)[key];
    });
  }
  define(window, 'matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  define(
    window,
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const emptyRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  });
  define(Range.prototype, 'getClientRects', emptyRects);
  define(Range.prototype, 'getBoundingClientRect', () => new DOMRect());
  define(Element.prototype, 'scrollIntoView', () => {});
  define(
    window,
    'ClipboardEvent',
    class ClipboardEvent extends Event {
      clipboardData: DataTransfer | null = null;
    },
  );
  return () => undo.reverse().forEach((u) => u());
}
