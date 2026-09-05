// apps/desktop install buttons share one shape: an idle "Download" affordance
// that, while a download is in flight, turns into a progress bar whose fill
// tracks completion. This is the single presentational primitive for that —
// pure (no store dependency), so every catalog section + the engine cards route
// through it. The live percent is computed at the call site (via the desktop
// `useInstallProgress` hook) and passed in.

import { Button, type ButtonProps } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

type InstallProgressButtonProps = Omit<
	ButtonProps,
	"variant" | "progress" | "children"
> & {
	/** Whether an install/download is currently running. */
	installing: boolean;
	/** Live completion 0–100, or null/undefined when the size is unknown. */
	percent?: number | null;
	/** Idle content (icon + label) shown when not installing. */
	children: ReactNode;
	/** Variant used at rest; the busy state always renders the `progress` variant. */
	idleVariant?: ButtonProps["variant"];
	/** Label beside the spinner while installing (a known percent replaces it). */
	busyLabel?: string;
};

/**
 * Install action button. At rest it renders `children` with `idleVariant`; while
 * `installing` it switches to the `progress` Button variant — the background
 * fills to `percent` (or stays a flat track with just a spinner when the size is
 * unknown) — and becomes non-interactive.
 */
function InstallProgressButton({
	installing,
	percent = null,
	idleVariant = "default",
	busyLabel = "Installing…",
	size = "sm",
	className,
	children,
	...props
}: InstallProgressButtonProps) {
	const reduceMotion = useReducedMotion();
	const shellTransition = reduceMotion
		? { duration: 0 }
		: { type: "spring" as const, stiffness: 420, damping: 32 };
	if (!installing) {
		return (
			<motion.div className="inline-flex" layout transition={shellTransition}>
				<Button
					className={className}
					size={size}
					variant={idleVariant}
					{...props}
				>
					{children}
				</Button>
			</motion.div>
		);
	}

	const known = percent != null && Number.isFinite(percent);
	const value = known ? Math.min(100, Math.max(0, percent)) : 0;

	return (
		<motion.div className="inline-flex" layout transition={shellTransition}>
			<Button
				aria-disabled
				className={cn("pointer-events-none", className)}
				loading
				progress={value}
				size={size}
				variant="progress"
			>
				<motion.span
					animate={{ opacity: 1, y: 0 }}
					initial={reduceMotion ? false : { opacity: 0, y: 2 }}
					key={known ? "percent" : "installing"}
					transition={reduceMotion ? { duration: 0 } : { duration: 0.16 }}
				>
					{known ? `${Math.round(value)}%` : busyLabel}
				</motion.span>
			</Button>
		</motion.div>
	);
}

export type { InstallProgressButtonProps };
export { InstallProgressButton };
