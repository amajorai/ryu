import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";

/**
 * Marks every focusable stop, for arrow-key travel along the path. Its value
 * is the stop's key (a thread id, or `add:<unit id>` for a unit's `+`), so the
 * path can keep a single tab stop (a roving tabindex).
 */
export const PATH_STOP_ATTRIBUTE = "data-path-stop";

export function pathAddKey(unitId: string): string {
	return `add:${unitId}`;
}

/**
 * How much room a row's art takes beyond the plain 64px coin and its 8px lip
 * (0 to 72px): a ring reaches 16px above and 8px below, the callout another
 * 56px above that, the dashed `+` and the chest sit inside it. Each row pads
 * by its own reach, so the air between any two neighbors is one 32px gap.
 */
export type PathRowFit = "add" | "art" | "callout" | "coin" | "ring";

const ROW_FIT = {
	add: "-mt-3 pb-5",
	art: "-mt-2 pb-6",
	callout: "pt-[72px] pb-10",
	coin: "pb-8",
	ring: "pt-4 pb-10",
} as const satisfies Record<PathRowFit, string>;

/**
 * One row of the path. Its 72px art box sits at the path's center plus
 * `swing` steps, so the path winds left and right; the steps and center are
 * CSS variables the list narrows on small widths.
 */
export function PathRow({
	children,
	className,
	done = false,
	fit,
	swing,
}: {
	children: ReactNode;
	className?: string;
	/** A finished stop: the trail up to it is trodden. */
	done?: boolean;
	fit: PathRowFit;
	swing: number;
}) {
	return (
		<li
			className={cn("relative", ROW_FIT[fit], className)}
			// SAFETY: React's CSSProperties omits custom properties; `--path-swing`
			// is a plain number the art box's margin calc multiplies by the step.
			style={{ "--path-swing": swing } as CSSProperties}
		>
			<div
				className="relative ml-[calc(var(--path-center)+var(--path-swing)*var(--path-step)-32px)] h-[72px] w-16"
				data-done={done ? "" : undefined}
			>
				{children}
			</div>
		</li>
	);
}

/** Labels sit on the open side of the swing; narrow paths keep them right. */
export function labelPlacement(swing: number): string {
	const base =
		"absolute top-[32px] w-max max-w-60 -translate-y-1/2 rounded-xl border-(--gk-edge)/15 border-2 bg-(--gk-plate)/92 px-3 py-1.5 shadow-[0_2px_0_var(--gk-shadow)] @max-[519px]/col:right-auto @max-[519px]/col:left-full @max-[519px]/col:ml-5 @max-[519px]/col:mr-0 @max-[519px]/col:w-[min(15rem,calc(74cqw-var(--path-step)*1.6-3.5rem))] @max-[519px]/col:text-left";
	return swing > 0
		? cn(base, "right-full mr-5 text-right")
		: cn(base, "left-full ml-5 text-left");
}

export function StopLabel({
	className,
	interactive = false,
	meta,
	metaClassName,
	swing,
	title,
	titleClassName,
}: {
	/** Extra placement classes (a smaller node sits its label closer). */
	className?: string;
	/** Underline the title on hover, when the label belongs to a button. */
	interactive?: boolean;
	meta: ReactNode;
	metaClassName?: string;
	swing: number;
	title: string;
	titleClassName?: string;
}) {
	return (
		<span aria-hidden="true" className={cn(labelPlacement(swing), className)}>
			<span
				className={cn(
					"line-clamp-2 font-bold text-(--gk-ink) text-[15px] leading-5 decoration-2 underline-offset-4",
					interactive && "group-hover/stop:underline",
					titleClassName
				)}
			>
				{title}
			</span>
			<span
				className={cn(
					"mt-0.5 block truncate font-semibold text-(--gk-ink-muted) text-[13px] leading-5",
					metaClassName
				)}
			>
				{meta}
			</span>
		</span>
	);
}

export const PRESS_BUTTON =
	"group/stop absolute inset-x-0 top-0 h-[72px] w-16 cursor-pointer rounded-full outline-none";
