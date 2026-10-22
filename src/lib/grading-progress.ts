/** What the interview shows while the council is scoring. Safe to import from the client. */
export type GradingProgressStage = "grading" | "aggregating" | "signing";

export interface GradingProgress {
  done: number;
  total: number;
  stage: GradingProgressStage;
}

export function gradingProgressLabel(progress: GradingProgress | null, failed: boolean): string {
  if (failed) return "Grading didn't finish.";
  if (!progress || progress.total <= 0) return "Grading council scoring…";
  switch (progress.stage) {
    case "aggregating":
      return "Combining the council's scores…";
    case "signing":
      return "Signing the receipt…";
    case "grading":
      return `${progress.done} of ${progress.total} graders done`;
    default: {
      const neverStage: never = progress.stage;
      return neverStage;
    }
  }
}

export function readGradingProgress(raw: string | null | undefined): GradingProgress | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { done?: unknown; total?: unknown; stage?: unknown };
    if (typeof value.done !== "number" || typeof value.total !== "number") return null;
    const stage: GradingProgressStage =
      value.stage === "aggregating" || value.stage === "signing" || value.stage === "grading"
        ? value.stage
        : "grading";
    return { done: value.done, total: value.total, stage };
  } catch {
    return null;
  }
}
