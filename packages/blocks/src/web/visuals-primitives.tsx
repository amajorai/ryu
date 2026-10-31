// Small pieces shared by the per-product hero visuals (./visuals.tsx and its
// ./visuals-desktop.tsx and ./visuals-services.tsx siblings).

export function Slot({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
			<span className="text-foreground/80 text-xs">{label}</span>
			<span className="shrink-0 text-foreground/80 text-xs md:text-sm">
				{value}
			</span>
		</div>
	);
}

/** A mock window's title-bar strip: three quiet dots, no label. */
export function WindowDots() {
	return (
		<span className="flex h-5 shrink-0 items-center gap-1 px-2">
			<span className="size-1.5 rounded-full bg-foreground/20" />
			<span className="size-1.5 rounded-full bg-foreground/20" />
			<span className="size-1.5 rounded-full bg-foreground/20" />
		</span>
	);
}
