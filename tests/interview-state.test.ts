import { describe, expect, it } from "vitest";
import { canSubmit, INITIAL_INTERVIEW, interviewReducer } from "../src/lib/interview-state";

describe("interview state machine", () => {
  it("walks start, answer, grade, and ignores a second submit", () => {
    let state = interviewReducer(INITIAL_INTERVIEW, { type: "start_ok", total: 2 });
    expect(canSubmit(state)).toBe(true);
    state = interviewReducer(state, { type: "submit" });
    expect(canSubmit(state)).toBe(false);
    expect(interviewReducer(state, { type: "submit" })).toEqual(state);
    state = interviewReducer(state, { type: "saved", answered: 1, total: 2 });
    expect(state).toMatchObject({ phase: "answering", index: 1 });
    state = interviewReducer(state, { type: "submit" });
    state = interviewReducer(state, { type: "save_fail", resume: "answering" });
    expect(state.phase).toBe("answering");
    state = interviewReducer(state, { type: "submit" });
    state = interviewReducer(state, { type: "saved", answered: 2, total: 2 });
    expect(state.phase).toBe("grading");
    state = interviewReducer(state, { type: "grade_fail" });
    expect(state.phase).toBe("grading");
    expect(canSubmit(state)).toBe(false);
    state = interviewReducer(state, { type: "grade_ok" });
    expect(state.phase).toBe("completed");
  });

  it("returns to the follow-up question after a failed save and can retry a failed start", () => {
    let state = interviewReducer(INITIAL_INTERVIEW, { type: "start_ok", total: 2 });
    state = interviewReducer(state, { type: "follow_up", answered: 2, total: 3 });
    expect(state).toMatchObject({ phase: "follow_up", index: 2, total: 3 });
    state = interviewReducer(state, { type: "submit" });
    state = interviewReducer(state, { type: "save_fail", resume: "follow_up" });
    expect(state.phase).toBe("follow_up");

    const failed = interviewReducer(INITIAL_INTERVIEW, { type: "start_fail" });
    expect(interviewReducer(failed, { type: "retry" }).phase).toBe("starting");
  });
});
