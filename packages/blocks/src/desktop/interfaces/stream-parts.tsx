import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { KeyboardEvent, ReactNode } from "react";
import { STREAM_TEXT } from "./stream-post.tsx";
import { STREAM_FOCUS } from "./stream-rail.tsx";

/**
 * A quiet, typographic empty state: one line saying what is missing and one
 * saying what fills it, plus an optional action. No illustration.
 */
export function StreamEmpty({
	action,
	description,
	title,
}: {
	action?: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<div className="flex flex-col items-center px-6 py-16 text-center">
			<p className={cn("font-semibold text-foreground", STREAM_TEXT)}>
				{title}
			</p>
			<p className={cn("mt-1 max-w-sm text-muted-foreground", STREAM_TEXT)}>
				{description}
			</p>
			{action ? <div className="mt-4">{action}</div> : null}
		</div>
	);
}

const SKELETON_ROWS = ["one", "two", "three", "four"] as const;
const SKELETON_WIDTHS = ["w-3/5", "w-4/5", "w-2/3", "w-3/4"] as const;

/** Post-shaped placeholders while the host's first snapshot loads. */
export function StreamSkeleton() {
	return (
		<div aria-busy="true" aria-label="Loading threads" role="status">
			{SKELETON_ROWS.map((key, index) => (
				<div className="flex gap-3 border-border border-b px-6 py-4" key={key}>
					<Skeleton className="size-9 shrink-0" radius="pill" />
					<div className="flex flex-1 flex-col gap-2 pt-0.5">
						<Skeleton className="h-3.5 w-28" radius="pill" />
						<Skeleton
							className={cn("h-3.5", SKELETON_WIDTHS[index])}
							radius="pill"
						/>
						<Skeleton className="h-3.5 w-11/12" radius="pill" />
					</div>
				</div>
			))}
		</div>
	);
}

/** The DOM id of one tab, so its panel can point back with aria-labelledby. */
export function streamTabId(baseId: string, value: string): string {
	return `${baseId}-tab-${value}`;
}

/** The DOM id of the panel a tablist controls. */
export function streamPanelId(baseId: string): string {
	return `${baseId}-panel`;
}

/**
 * Roving focus for a tablist: Left/Right (and Home/End) move to the next tab
 * and select it, wrapping at the ends, the way WAI-ARIA tabs behave.
 */
export function onStreamTabKeyDown<T extends string>(
	event: KeyboardEvent<HTMLElement>,
	baseId: string,
	options: readonly { value: T }[],
	value: T,
	onChange: (value: T) => void
): void {
	const index = options.findIndex((option) => option.value === value);
	let next = -1;
	if (event.key === "ArrowRight") {
		next = (index + 1) % options.length;
	} else if (event.key === "ArrowLeft") {
		next = (index - 1 + options.length) % options.length;
	} else if (event.key === "Home") {
		next = 0;
	} else if (event.key === "End") {
		next = options.length - 1;
	}
	const target = options[next];
	if (!target) {
		return;
	}
	event.preventDefault();
	onChange(target.value);
	const tab = event.currentTarget.ownerDocument.getElementById(
		streamTabId(baseId, target.value)
	);
	tab?.focus();
}

/** Text tabs that fill the column width, underlined when current. */
export function StreamTabs<T extends string>({
	baseId,
	label,
	onChange,
	options,
	value,
}: {
	baseId: string;
	label: string;
	onChange: (value: T) => void;
	options: { label: string; value: T }[];
	value: T;
}) {
	return (
		<div
			aria-label={label}
			className="flex border-border border-b"
			role="tablist"
		>
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button
						aria-controls={streamPanelId(baseId)}
						aria-selected={selected}
						className={cn(
							"relative h-12 flex-1 font-semibold transition-colors duration-150",
							STREAM_TEXT,
							selected
								? "text-foreground"
								: "text-muted-foreground hover:text-foreground",
							STREAM_FOCUS,
							"focus-visible:ring-inset focus-visible:ring-offset-0"
						)}
						id={streamTabId(baseId, option.value)}
						key={option.value}
						onClick={() => onChange(option.value)}
						onKeyDown={(event) =>
							onStreamTabKeyDown(event, baseId, options, value, onChange)
						}
						role="tab"
						tabIndex={selected ? 0 : -1}
						type="button"
					>
						{option.label}
						<span
							aria-hidden="true"
							className={cn(
								"absolute inset-x-0 -bottom-px h-px",
								selected ? "bg-foreground" : "bg-transparent"
							)}
						/>
					</button>
				);
			})}
		</div>
	);
}

/** Outlined pills for the Activity filters, filled when current. */
export function StreamChips<T extends string>({
	label,
	onChange,
	options,
	value,
}: {
	label: string;
	onChange: (value: T) => void;
	options: { count: number; label: string; value: T }[];
	value: T;
}) {
	return (
		<div aria-label={label} className="flex gap-2 px-6 py-3" role="toolbar">
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<button
						aria-pressed={selected}
						className={cn(
							"flex h-9 items-center gap-1.5 rounded-xl border px-4 font-semibold text-sm transition-colors duration-150",
							selected
								? "border-foreground bg-foreground text-background"
								: "border-border text-foreground hover:bg-muted",
							STREAM_FOCUS
						)}
						key={option.value}
						onClick={() => onChange(option.value)}
						type="button"
					>
						{option.label}
						<span
							className={cn(
								"tabular-nums",
								selected ? "text-background/70" : "text-muted-foreground"
							)}
						>
							{option.count}
						</span>
					</button>
				);
			})}
		</div>
	);
}
