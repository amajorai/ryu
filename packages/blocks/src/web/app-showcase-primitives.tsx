import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/* Shared skeleton primitives                                                  */
/* -------------------------------------------------------------------------- */

export function TrafficLights() {
	return (
		<div aria-hidden="true" className="flex items-center gap-1.5">
			<span className="size-2 rounded-full bg-foreground/15" />
			<span className="size-2 rounded-full bg-foreground/15" />
			<span className="size-2 rounded-full bg-foreground/15" />
		</div>
	);
}

export function MockupWindow({
	children,
	className,
	label,
}: {
	children: ReactNode;
	className?: string;
	label: string;
}) {
	return (
		<div
			className={cn(
				"w-full overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-sm",
				className
			)}
			data-app-mockup
		>
			<div className="flex h-8 items-center gap-2 border-border border-b bg-muted/50 px-3">
				<TrafficLights />
				<span className="type-micro min-w-0 truncate font-mono text-muted-foreground">
					{label}
				</span>
				<span className="type-micro ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-muted-foreground">
					<span className="size-1.5 rounded-full bg-success" />
					ready
				</span>
			</div>
			{children}
		</div>
	);
}

export function MockupSidebar({
	active,
	items,
}: {
	active: string;
	items: readonly string[];
}) {
	return (
		<aside className="hidden border-border border-r bg-muted/20 p-2 sm:block">
			<div className="mb-5 flex items-center gap-1.5 px-1.5">
				<span className="type-tiny flex size-4 items-center justify-center rounded bg-foreground font-semibold text-background">
					R
				</span>
				<span className="type-compact font-heading font-medium">Ryu</span>
			</div>
			<div className="space-y-0.5">
				{items.map((item) => (
					<div
						className={cn(
							"type-micro flex items-center gap-1.5 rounded px-1.5 py-1.5",
							item === active
								? "bg-foreground/10 font-medium text-foreground"
								: "text-muted-foreground"
						)}
						key={item}
					>
						<span
							className={cn(
								"size-1.5 rounded-full",
								item === active ? "bg-primary" : "bg-foreground/15"
							)}
						/>
						{item}
					</div>
				))}
			</div>
		</aside>
	);
}

export function MiniButton({ children }: { children: ReactNode }) {
	return (
		<span className="type-micro inline-flex items-center rounded border border-border bg-background px-2 py-1 font-medium text-foreground">
			{children}
		</span>
	);
}

export function MiniPill({
	children,
	active = false,
}: {
	children: ReactNode;
	active?: boolean;
}) {
	return (
		<span
			className={cn(
				"type-micro inline-flex items-center rounded-full border px-2 py-0.5 font-mono",
				active
					? "border-primary/30 bg-primary/10 text-foreground"
					: "border-border bg-muted/40 text-muted-foreground"
			)}
		>
			{children}
		</span>
	);
}

export function MiniLines({
	count = 3,
	widths = ["w-full", "w-4/5", "w-3/5"],
}: {
	count?: number;
	widths?: string[];
}) {
	return (
		<div className="space-y-1.5">
			{Array.from({ length: count }, (_, index) => (
				<span
					className={cn(
						"block h-1 rounded-full bg-foreground/10",
						widths[index % widths.length]
					)}
					key={`line-${index}`}
				/>
			))}
		</div>
	);
}
