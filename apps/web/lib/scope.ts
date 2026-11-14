/**
 * Memory scope, same rule as apps/worker/src/scope.ts: company-wide context lives under the reserved project COMPANY_PROJECT,
 * each project's own decisions under its id. A call in project P reads P + company and writes only P.
 */
export const COMPANY_PROJECT = "company";

export function readableProjects(projectId: string): string[] {
  return projectId === COMPANY_PROJECT ? [COMPANY_PROJECT] : [projectId, COMPANY_PROJECT];
}

export function memoryFilter(scope: { teamId: string; projectId: string }) {
  return { teamId: scope.teamId, projectId: { $in: readableProjects(scope.projectId) }, status: "active" as const };
}
