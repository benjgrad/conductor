import { useCallback } from 'react';
import { useToast } from './Toast.js';

/**
 * UXR-55: copies `text` and says "Copied" in the shared toast. Resolves false when there is no
 * clipboard or the write is refused; the caller shows that inline.
 */
export function useCopy(): (text: string) => Promise<boolean> {
  const toast = useToast();
  return useCallback(
    async (text: string) => {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard) return false;
      try {
        await clipboard.writeText(text);
      } catch {
        return false;
      }
      toast('Copied');
      return true;
    },
    [toast],
  );
}
