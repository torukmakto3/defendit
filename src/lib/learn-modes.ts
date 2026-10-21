/**
 * Learn modes. Flashcards are ready. Quiz, explain-back, and weak-spot review
 * are specified here so the next change can build one mode on this shell.
 *
 * Weak-spot review reads the private gap map a Defend interview already stores
 * (`sessions.gap_map`). It does not change the understanding score.
 */

export type LearnModeId = "flashcards" | "quiz" | "explain_back" | "weak_spots";

export type LearnModeStatus = "ready" | "next";

export interface LearnMode {
  id: LearnModeId;
  label: string;
  status: LearnModeStatus;
  /** One line on the mode switcher and the not-yet panel. */
  summary: string;
}

export const LEARN_MODES: readonly LearnMode[] = [
  {
    id: "flashcards",
    label: "Flashcards",
    status: "ready",
    summary: "Recall one idea from your file, then check it.",
  },
  {
    id: "quiz",
    label: "Quiz",
    status: "next",
    summary: "A few short checks on the same ideas, scored only for you.",
  },
  {
    id: "explain_back",
    label: "Explain it back",
    status: "next",
    summary: "Say a section in your own words before you see the file's wording.",
  },
  {
    id: "weak_spots",
    label: "Weak spots",
    status: "next",
    summary: "Practice the sections a Defend interview marked weak or partial.",
  },
] as const;

export const DEFAULT_LEARN_MODE: LearnModeId = "flashcards";

export function learnMode(id: LearnModeId): LearnMode {
  switch (id) {
    case "flashcards":
    case "quiz":
    case "explain_back":
    case "weak_spots": {
      const mode = LEARN_MODES.find((item) => item.id === id);
      if (mode) return mode;
      throw new Error(`Learn mode ${id} is missing from the catalog`);
    }
    default: {
      const unknown: never = id;
      throw new Error(`Unknown Learn mode: ${String(unknown)}`);
    }
  }
}

export function learnModeStatus(id: LearnModeId): LearnModeStatus {
  switch (id) {
    case "flashcards":
      return "ready";
    case "quiz":
    case "explain_back":
    case "weak_spots":
      return "next";
    default: {
      const unknown: never = id;
      return unknown;
    }
  }
}

export interface InterviewGap {
  section: string;
  strength: "weak" | "partial" | "strong";
  note?: string;
}

/**
 * Sections a weak-spot review would open, weakest first.
 * Strong sections stay out: they are not a gap.
 */
export function weakSpotSections(gaps: InterviewGap[]): InterviewGap[] {
  const rank: Record<InterviewGap["strength"], number> = { weak: 0, partial: 1, strong: 2 };
  return gaps
    .filter((gap) => gap.strength === "weak" || gap.strength === "partial")
    .sort((a, b) => rank[a.strength] - rank[b.strength] || a.section.localeCompare(b.section));
}
