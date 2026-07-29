import { useEffect } from "react";

export function useEscape(close: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => event.key === "Escape" && close();
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [close, enabled]);
}
