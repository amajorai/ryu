import type { ReactNode } from "react";

/**
 * A number tile's body: one figure and a short phrase that says what it
 * counts. The widget header above it carries the label.
 */
export function StatValue({
	context,
	value,
}: {
	context: ReactNode;
	value: number | string;
}) {
	return (
		<p className="flex min-w-0 items-baseline gap-2">
			<span className="font-semibold text-3xl text-foreground leading-9 tracking-tight">
				{value}
			</span>
			<span className="min-w-0 truncate text-muted-foreground text-sm">
				{context}
			</span>
		</p>
	);
}
