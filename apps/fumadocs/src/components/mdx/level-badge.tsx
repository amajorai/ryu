import type { ReactNode } from "react";

/**
 * Academy course-difficulty levels, numbered like university courses:
 * 100 is the gentlest, each +100 step is more advanced. The `tone` classes
 * are Tailwind utilities that read well on both the light and dark Fumadocs
 * themes.
 */
const LEVEL_TIERS = [
  {
    min: 100,
    label: "Beginner",
    tone: "bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
  },
  {
    min: 200,
    label: "Intermediate",
    tone: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:text-sky-300",
  },
  {
    min: 300,
    label: "Advanced",
    tone: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300",
  },
  {
    min: 400,
    label: "Expert",
    tone: "bg-orange-500/15 text-orange-700 ring-orange-500/30 dark:text-orange-300",
  },
  {
    min: 500,
    label: "Master",
    tone: "bg-fuchsia-500/15 text-fuchsia-700 ring-fuchsia-500/30 dark:text-fuchsia-300",
  },
] as const;

const DEFAULT_TIER = LEVEL_TIERS[0];

function tierForLevel(level: number) {
  let match: (typeof LEVEL_TIERS)[number] = DEFAULT_TIER;
  for (const tier of LEVEL_TIERS) {
    if (level >= tier.min) {
      match = tier;
    }
  }
  return match;
}

/**
 * A small pill that shows an Academy course level (e.g. `100 · Beginner`).
 * The difficulty tier is derived from the number, so a lesson only needs to
 * declare `level:` in its frontmatter.
 */
export function LevelBadge({
  level,
  showLabel = true,
}: {
  level: number;
  showLabel?: boolean;
}): ReactNode {
  const tier = tierForLevel(level);

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 font-medium text-xs ring-1 ring-inset ${tier.tone}`}
      title={`Level ${level} · ${tier.label}`}
    >
      <span className="font-semibold tabular-nums">{level}</span>
      {showLabel ? (
        <span className="opacity-80">{tier.label}</span>
      ) : null}
    </span>
  );
}
