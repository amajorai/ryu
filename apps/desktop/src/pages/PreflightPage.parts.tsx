import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useId } from "react";

export type Tone = "ok" | "warn" | "bad" | "pending";

export const TONE_CLASS = {
	ok: "bg-success",
	warn: "bg-warning",
	bad: "bg-destructive",
	pending: "bg-muted-foreground",
} satisfies Record<Tone, string>;

export function StatusDot({ tone }: { tone: Tone }) {
	return (
		<span className={cn("size-1.5 shrink-0 rounded-full", TONE_CLASS[tone])} />
	);
}

/**
 * One component as a disclosure row of the embedded (Settings) card: the status
 * line is the trigger, its controls open beneath it inside the same row. The
 * trigger's accessible name starts with the component name and carries
 * `aria-expanded`, which the preflight proof drives.
 */
export function ComponentRow({
	children,
	onToggle,
	open,
	title,
}: {
	children: ReactNode;
	onToggle: () => void;
	open: boolean;
	title: ReactNode;
}) {
	const id = useId();
	return (
		<div>
			<button
				aria-controls={`${id}-panel`}
				aria-expanded={open}
				className="flex min-h-12 w-full min-w-0 items-center gap-3 py-3 text-left text-sm outline-none focus-visible:bg-muted"
				id={`${id}-trigger`}
				onClick={onToggle}
				type="button"
			>
				<span className="min-w-0 flex-1">{title}</span>
				<HugeiconsIcon
					aria-hidden
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-180"
					)}
					icon={ArrowDown01Icon}
				/>
			</button>
			<div
				aria-labelledby={`${id}-trigger`}
				className="pb-3 text-muted-foreground text-sm"
				hidden={!open}
				id={`${id}-panel`}
				role="region"
			>
				{children}
			</div>
		</div>
	);
}
