import { AVAILABLE_WORKFLOW_FEATURES, type WorkflowFeature } from '@conductor/shared';

// ADR-0039 (B3): the workflow features the web app treats as available. The server's list
// (`AVAILABLE_WORKFLOW_FEATURES`), plus `bases` in the mock app's `?mock-bases=1` scene, so the
// ticket Base control and the designer's Bases section can be seen active before B2 ships them.

/** `?mock-bases=1` on the mock app (VITE_API=mock): the base-refs scene. */
export function mockBasesScene(
  env: Record<string, unknown> = import.meta.env,
  search: string = typeof location === 'undefined' ? '' : location.search,
): boolean {
  return env.VITE_API === 'mock' && new URLSearchParams(search).get('mock-bases') === '1';
}

/** The features the UI offers: the server's, plus `bases` in the mock base-refs scene. */
export function webWorkflowFeatures(): readonly WorkflowFeature[] {
  return mockBasesScene() ? [...AVAILABLE_WORKFLOW_FEATURES, 'bases'] : AVAILABLE_WORKFLOW_FEATURES;
}

/** True when ticket and workflow bases are live (B2), or in the mock scene. */
export function basesAvailable(features: readonly WorkflowFeature[]): boolean {
  return features.includes('bases');
}
