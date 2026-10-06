// Whether to animate: the person's own Motion setting (carried as data-motion on the app shell) wins;
// "system" follows the OS reduced-motion preference. Client-side only.
export function motionAllowed(): boolean {
  const pref = document.querySelector<HTMLElement>("[data-motion]")?.dataset.motion;
  if (pref === "on") return true;
  if (pref === "off") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
