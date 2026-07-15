import type { ReactNode } from "react";

const ALPHA_REALMS = new Set(["cli", "hardware", "mobile"]);

export function isAlphaRealm(segment: string): boolean {
  return ALPHA_REALMS.has(segment);
}

export function AlphaBadge(): ReactNode {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full bg-violet-500/15 px-1.5 py-0.5 font-medium text-[0.625rem] uppercase tracking-wide text-violet-700 ring-1 ring-violet-500/30 ring-inset dark:text-violet-300"
      title="Early preview — APIs and UX may change"
    >
      Alpha
    </span>
  );
}

export function realmTabTitle(title: ReactNode, segment: string): ReactNode {
  if (!isAlphaRealm(segment)) {
    return title;
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {title}
      <AlphaBadge />
    </span>
  );
}
