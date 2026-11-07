import { useSyncExternalStore } from "react";

const revealed = new Set<string>();
const lastOpened = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function reveal(key: string) {
  if (revealed.has(key)) return;
  revealed.add(key);
  for (const listener of listeners) listener();
}

export function useRevealed(key: string): boolean {
  return useSyncExternalStore(subscribe, () => revealed.has(key));
}

export function lastOpenedPullRequest(key: string): string | undefined {
  return lastOpened.get(key);
}

const MAX_FRAMES = 30;

export function openRevealed(key: string, url: string, attempt: () => boolean, onFail?: () => void): void {
  lastOpened.set(key, url);
  if (attempt()) return;
  reveal(key);
  let frames = 0;
  const retry = () => {
    if (attempt()) return;
    frames += 1;
    if (frames < MAX_FRAMES) window.requestAnimationFrame(retry);
    else onFail?.();
  };
  window.requestAnimationFrame(retry);
}
