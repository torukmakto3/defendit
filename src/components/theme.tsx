"use client";

import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";
const KEY = "defend-it:theme";

/**
 * Runs before first paint (inlined in <head>): applies a stored Day/Night
 * choice so the page never flashes the wrong theme. No stored choice means
 * the OS setting decides, via prefers-color-scheme in globals.css.
 */
export const themeBootScript = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

function effectiveTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const follow = () => onStoreChange();
  mq.addEventListener("change", follow);
  return () => {
    listeners.delete(onStoreChange);
    mq.removeEventListener("change", follow);
  };
}

function emit() {
  for (const listener of listeners) listener();
}

function getSnapshot(): Theme | null {
  return effectiveTheme();
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => null);

  function choose(next: Theme) {
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    emit();
  }

  return (
    <span className="theme-toggle" role="group" aria-label="Theme">
      <button type="button" aria-pressed={theme === "light"} onClick={() => choose("light")}>
        Day
      </button>
      <button type="button" aria-pressed={theme === "dark"} onClick={() => choose("dark")}>
        Night
      </button>
    </span>
  );
}
