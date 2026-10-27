// UX-8 FR-1: "I'll do this later" hides the first-run guide for this visit only; it comes back on
// the next visit while the account still has no machines. Stored per user in localStorage as the
// id of the visit (one per page load) that dismissed it. Storage failures mean "not dismissed".

let visit: string = crypto.randomUUID();

/** This page load's visit id. */
export const currentVisit = (): string => visit;

/** Tests: start a new visit, as a reload would. */
export function newVisitForTests(): void {
  visit = crypto.randomUUID();
}

const key = (userId: string) => `conductor.setupGuide.dismissed.${userId}`;

export function isDismissed(userId: string, visitId: string = visit): boolean {
  try {
    return localStorage.getItem(key(userId)) === visitId;
  } catch {
    return false;
  }
}

export function dismiss(userId: string, visitId: string = visit): void {
  try {
    localStorage.setItem(key(userId), visitId);
  } catch {
    // Without storage it is simply shown again on the next visit; this visit hides it in state.
  }
}
