---
name: Titleblock
description: Defend It's visual system. An engineering drawing sheet: graph paper, registration marks, a title block that signs off the work.
colors:
  day:
    sheet: "#F5F7FA"      # page ground
    grid: "#DDE4EE"       # graph-paper lines (decorative only)
    card: "#FFFFFF"       # panels, inputs
    ink: "#0E1726"        # text, panel borders
    ink-2: "#4A5568"      # secondary text (7.4:1 on sheet)
    line: "#C7D0DC"       # hairlines between rows
    blueprint: "#1F4BD8"  # primary actions, links, focus (6.6:1 on card)
    blueprint-ink: "#FFFFFF"
    signal: "#C2410C"     # stamps, warnings, the one hot accent (5.2:1 on card)
    ok: "#0F7A55"
    danger: "#B42318"
  night:
    sheet: "#0B1F4A"      # true blueprint
    grid: "#1A3168"
    card: "#0F2858"
    ink: "#E8F0FF"
    ink-2: "#A9BCE6"
    line: "#2A4A8C"
    blueprint: "#8FB0FF"
    blueprint-ink: "#0B1F4A"
    signal: "#FF8A57"
    ok: "#4AD39B"
    danger: "#FF8A80"
typography:
  display: { family: "Sora", weights: [600, 700], use: "page titles, question text" }
  body: { family: "Public Sans", weights: [400, 600], size: "16px", line-height: 1.55 }
  mono: { family: "JetBrains Mono", weights: [400, 600], use: "labels, hashes, ids, counters (uppercase, +0.08em tracking for labels)" }
  scale: [12, 14, 16, 19, 24, 32, 44]
rounded: { panel: 0, control: 2, chip: 999 }
spacing: { unit: 4, gutter: 16, panel-padding: 20 }
---

# Titleblock

Defend It certifies that someone understands a piece of work. The visual language borrows from
the drawing office, where a title block in the corner of a sheet records who checked a drawing,
which revision, and when. That is what a receipt is.

## Rules

- **Two themes, one system.** Day is graph paper; night is a blueprint. Every colour is a token,
  defined for both. The site follows the OS setting until the person picks Day or Night in the
  header; the choice is remembered on that device.
- **One hot accent.** `signal` is reserved for the APPROVED stamp, the planted-error probe label
  and warnings. Primary actions are `blueprint`.
- **Panels are square and outlined** (1.5px `ink`), with two blueprint registration marks at
  opposite corners (`.panel`). No drop shadows, no rounded cards.
- **Labels are mono, uppercase, tracked.** Hashes, receipt ids, probe numbers and counters are
  always mono and tabular.
- **The grid is decoration.** Text never relies on it for contrast; it sits at the lowest
  contrast and stops under panels.
- **The receipt is a title block.** Cells: Outcome, Score, Level, Date, SHA-256, signed by.
  The stamp image is always the day palette (it travels in emails and PDFs).

## Companion

A line-art robot head: CRT eyes on a bracket, an antenna with a signal-coloured light. One SVG
component (`src/components/companion`) with five states:

| State | When | Pose |
|---|---|---|
| listening | default; the person is reading or typing | eyes forward, pupils follow the pointer |
| thinking | waiting on the model or saving | eyes narrow to scan lines, pupils up-right |
| skeptical | a weak answer in Learn; a "Not defended" receipt | one brow angled down in `signal` |
| surprised | a strong answer in Learn; a "Defended" receipt; a file dragged over the drop zone | eyes grow tall, pupils shrink, antenna flashes, small hop |
| impressed | reserved for streaks and milestones | eyes become `^ ^` |

Motion respects `prefers-reduced-motion` (no blinking, tracking or hops; poses still change).
The face is decorative (`aria-hidden`); state changes that matter are also stated in text.
