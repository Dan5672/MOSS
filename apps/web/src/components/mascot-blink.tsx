"use client";

import { useEffect, useState } from "react";
import { MascotSvg, type MascotSvgProps } from "./mascot-svg";

const BLINK_EVERY_MS = 3600;
const JITTER_MS = 1500;
const BLINK_FOR_MS = 140;

/** Blinks every ~3.6s (plus jitter). Never blinks when the user prefers reduced motion. */
export function BlinkingMascot(props: Omit<MascotSvgProps, "blinking">) {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setBlinking(true);
        timer = setTimeout(() => {
          setBlinking(false);
          schedule();
        }, BLINK_FOR_MS);
      }, BLINK_EVERY_MS + Math.random() * JITTER_MS);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  return <MascotSvg {...props} blinking={blinking} />;
}
