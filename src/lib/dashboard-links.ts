/**
 * Where the dashboard's Workspace link goes.
 *
 * A creator who has uploaded a file opens Learn, which starts on flashcards.
 * That includes a finished defense. The receipt stays on its own link.
 *
 * A receiver is waiting on someone else's defense, so Workspace stays on the
 * request page: share the link, read status. Learn is private to the creator.
 *
 * A creator row that is still pending has no file yet, so it stays on the
 * request page, where the upload form is.
 */
export interface DashboardWorkspaceRow {
  token: string;
  role: "creator" | "receiver";
  status: string;
}

export function dashboardWorkspaceHref(row: DashboardWorkspaceRow): string {
  if (row.role === "creator" && (row.status === "uploaded" || row.status === "defended")) {
    return `/d/${row.token}/learn`;
  }
  return `/d/${row.token}`;
}
