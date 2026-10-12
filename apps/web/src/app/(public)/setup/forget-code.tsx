"use client";

import { useEffect } from "react";

/** Takes the setup code out of the address bar (and so out of browser history) once the form has it. */
export function ForgetCode() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("code")) return;
    url.searchParams.delete("code");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
  return null;
}
