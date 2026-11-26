// The onboarding tour (Support Signup): shown once, right after someone creates their account,
// and on demand from the account menu ("Getting started"). Sign-up marks it pending for that user
// in localStorage; closing it (Skip, Done, Escape) clears the mark. Storage failures mean "not
// pending": the tour is a welcome, never a gate.

const key = (userId: string) => `conductor.tour.pending.${userId}`;

export function markTourPending(userId: string): void {
  try {
    localStorage.setItem(key(userId), '1');
  } catch {
    // No storage: the tour is still in the account menu.
  }
}

export function isTourPending(userId: string): boolean {
  try {
    return localStorage.getItem(key(userId)) === '1';
  } catch {
    return false;
  }
}

export function clearTourPending(userId: string): void {
  try {
    localStorage.removeItem(key(userId));
  } catch {
    // Nothing to clear.
  }
}
