/** Shared in-process exclusion between deployment and lifecycle mutations. */
export const activeReleaseScopes = new Set<string>();
