import { useEffect, useState } from 'react';

/**
 * Milliseconds left until `expiresAt` (an ISO time), ticking every second until it reaches 0.
 * A new expiry needs a new component (callers key it by the token).
 */
export function useCountdown(expiresAt: string): number {
  const end = Date.parse(expiresAt);
  const [left, setLeft] = useState(() => end - Date.now());
  const expired = left <= 0;

  useEffect(() => {
    if (expired) return;
    const timer = setInterval(() => setLeft(end - Date.now()), 1000);
    return () => clearInterval(timer);
  }, [end, expired]);

  return left;
}
