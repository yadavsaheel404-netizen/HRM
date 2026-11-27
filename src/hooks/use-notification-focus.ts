import { useEffect, useRef } from "react";

/**
 * Scrolls to `[data-focus-id="<targetId>"]` (or element with matching id) when mounted/loaded
 * and highlights it briefly with a subtle focus ring so users land directly on the notification item.
 */
export function useNotificationFocus(
  targetId: string | null | undefined,
  options?: { ready?: boolean; onMissing?: () => void },
) {
  const ready = options?.ready ?? true;
  const handledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!targetId || !ready) return;
    const key = `${targetId}`;
    if (handledRef.current === key) return;

    const timer = window.setTimeout(() => {
      const selectorSafe = targetId.replace(/"/g, '\\"');
      const el =
        (document.querySelector(`[data-focus-id="${selectorSafe}"]`) as HTMLElement | null) ||
        document.getElementById(targetId);

      if (!el) {
        handledRef.current = key;
        options?.onMissing?.();
        return;
      }

      handledRef.current = key;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-primary", "ring-offset-2", "transition-shadow");
      window.setTimeout(() => {
        el.classList.remove("ring-2", "ring-primary", "ring-offset-2");
      }, 3500);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [targetId, ready, options]);
}
