import { type RefObject, useEffect, useState } from "react";

const DEFAULT_MARGIN = "600px 0px";

interface SharedObserver {
  ctor: typeof IntersectionObserver;
  observer: IntersectionObserver;
  targets: Map<Element, () => void>;
}

const observers = new Map<string, SharedObserver>();

const isNoopDomObserver = () =>
  typeof window !== "undefined" &&
  "happyDOM" in window &&
  IntersectionObserver === (window as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;

function acquireObserver(rootMargin: string): SharedObserver | null {
  if (typeof IntersectionObserver !== "function" || isNoopDomObserver()) return null;
  const existing = observers.get(rootMargin);
  if (existing) {
    if (existing.ctor === IntersectionObserver) return existing;
    existing.observer.disconnect();
    observers.delete(rootMargin);
  }
  const targets = new Map<Element, () => void>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const hit = targets.get(entry.target);
        if (!hit) continue;
        targets.delete(entry.target);
        observer.unobserve(entry.target);
        hit();
      }
      if (targets.size === 0) {
        observer.disconnect();
        const cur = observers.get(rootMargin);
        if (cur?.observer === observer) observers.delete(rootMargin);
      }
    },
    { rootMargin },
  );
  const shared: SharedObserver = { ctor: IntersectionObserver, observer, targets };
  observers.set(rootMargin, shared);
  return shared;
}

/**
 * Latches to `true` once `ref` enters `rootMargin` of the viewport (or immediately when `skip` is true,
 * `IntersectionObserver` is unavailable, or happy-dom's no-op observer is active).
 */
export function useNearViewport<T extends Element = HTMLElement>(
  ref: RefObject<T | null>,
  options: { rootMargin?: string; skip?: boolean } = {},
): boolean {
  const { rootMargin = DEFAULT_MARGIN, skip = false } = options;
  const eager = skip || typeof IntersectionObserver !== "function" || isNoopDomObserver();
  const [near, setNear] = useState(eager);

  useEffect(() => {
    if (near || eager) {
      if (!near && eager) setNear(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const shared = acquireObserver(rootMargin);
    if (!shared) {
      setNear(true);
      return;
    }
    shared.targets.set(el, () => setNear(true));
    shared.observer.observe(el);
    return () => {
      shared.targets.delete(el);
      shared.observer.unobserve(el);
      if (shared.targets.size === 0) {
        shared.observer.disconnect();
        const cur = observers.get(rootMargin);
        if (cur?.observer === shared.observer) observers.delete(rootMargin);
      }
    };
  }, [ref, near, eager, rootMargin]);

  return near;
}
