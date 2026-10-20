/**
 * Client-side phase of a Defend interview. The server still owns the transcript;
 * this only decides which control the page may show, so a double click or a
 * failed grade cannot skip a question or ask for an answer that was already saved.
 */
export type DefendPhase = "starting" | "answering" | "saving" | "grading" | "follow_up" | "completed" | "error";

export interface InterviewState {
  phase: DefendPhase;
  /** Index of the question currently on screen. */
  index: number;
  total: number;
}

export type InterviewEvent =
  | { type: "start_ok"; total: number }
  | { type: "start_fail" }
  | { type: "submit" }
  | { type: "saved"; answered: number; total: number }
  | { type: "save_fail"; resume: "answering" | "follow_up" }
  | { type: "grade_ok" }
  | { type: "grade_fail" }
  | { type: "follow_up"; answered: number; total: number }
  | { type: "retry" };

export const INITIAL_INTERVIEW: InterviewState = { phase: "starting", index: 0, total: 0 };

export function interviewReducer(state: InterviewState, event: InterviewEvent): InterviewState {
  switch (event.type) {
    case "start_ok":
      return { phase: "answering", index: 0, total: event.total };
    case "start_fail":
      return { phase: "error", index: 0, total: 0 };
    case "submit":
      if (state.phase !== "answering" && state.phase !== "follow_up") return state;
      return { ...state, phase: "saving" };
    case "saved":
      if (event.answered >= event.total) {
        return { phase: "grading", index: event.answered, total: event.total };
      }
      return { phase: "answering", index: event.answered, total: event.total };
    case "save_fail":
      if (state.phase !== "saving") return state;
      return { ...state, phase: event.resume };
    case "grade_ok":
      return { ...state, phase: "completed" };
    case "grade_fail":
      return { ...state, phase: "grading" };
    case "follow_up":
      return { phase: "follow_up", index: event.answered, total: event.total };
    case "retry":
      if (state.phase === "error") return { phase: "starting", index: 0, total: 0 };
      return state;
    default: {
      const neverEvent: never = event;
      return neverEvent;
    }
  }
}

/** Saving and grading ignore a second click. */
export function canSubmit(state: InterviewState): boolean {
  return state.phase === "answering" || state.phase === "follow_up";
}

export function canGrade(state: InterviewState): boolean {
  return state.phase === "grading";
}
