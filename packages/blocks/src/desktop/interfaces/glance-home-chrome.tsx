import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import type { GlanceDistance } from "./glance-model.ts";
import { GLANCE_INK_SECONDARY } from "./glance-parts.tsx";
import { agentById } from "./interface-renderer.ts";

/** Apple's widget families on a four-column grid: 1x1, 2x1, 2x2. */
export type WidgetSize = "large" | "medium" | "small";

export const SPAN: Record<WidgetSize, string> = {
	large: "col-span-2 row-span-2",
	medium: "col-span-2",
	small: "col-span-1",
};

/** Widget type, in display-relative units with legible floors. */
export const W = {
	big: "text-[clamp(1.75rem,7.6cqw,3.5rem)] leading-none tracking-[-0.03em]",
	label: "text-[clamp(0.8125rem,2.5cqw,1.125rem)] leading-tight",
	row: "text-[clamp(0.8125rem,2.4cqw,1.0625rem)] leading-snug",
	sub: "text-[clamp(0.75rem,2.1cqw,0.9375rem)] leading-snug",
} as const;

export const ROW_BUTTON =
	"-mx-[1.6cqw] flex w-[calc(100%+3.2cqw)] min-w-0 rounded-[1.8cqw] px-[1.6cqw] text-left outline-none transition-colors corner-squircle hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.08]";

export function Widget({
	accessory,
	children,
	className,
	label,
	size,
	title,
}: {
	/** Top-right count, set on the title's baseline. */
	accessory?: ReactNode;
	children: ReactNode;
	className?: string;
	label: string;
	size: WidgetSize;
	title?: string;
}) {
	return (
		<section
			aria-label={label}
			className={cn(
				"corner-squircle flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4.4cqw] bg-muted p-[3.4cqw]",
				"@max-[32rem]:gap-3 gap-[1.6cqw] @max-[32rem]:rounded-3xl @max-[32rem]:p-4",
				size === "small" && "@max-[32rem]:min-h-36",
				SPAN[size],
				className
			)}
			data-widget={label}
			data-widget-size={size}
		>
			{title ? (
				<header className="flex items-baseline justify-between gap-[2cqw]">
					<h3 className={cn("font-semibold text-foreground", W.label)}>
						{title}
					</h3>
					{accessory}
				</header>
			) : null}
			{children}
		</section>
	);
}

export function Quiet({ children }: { children: ReactNode }) {
	return <p className={cn(GLANCE_INK_SECONDARY, W.row)}>{children}</p>;
}

export function names(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	const list = thread.agentIds
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name): name is string => Boolean(name));
	return list.length > 0 ? list.join(", ") : "No agent";
}

/** A header count: the title's size, quiet ink, aligned figures. */
export function HeaderCount({ children }: { children: ReactNode }) {
	return (
		<span
			className={cn(
				"shrink-0 font-medium tabular-nums",
				GLANCE_INK_SECONDARY,
				W.label
			)}
		>
			{children}
		</span>
	);
}

export interface GlanceHomeProps {
	distance: GlanceDistance;
	loading: boolean;
	now: number;
	onOpenThread: (threadId: string) => void;
	onStartWithAgent: (agentId: string) => void;
	snapshot: InterfaceSnapshot;
}

/**
 * The small widgets' figure size, in units of the figure's own width: four
 * characters ("9:41") take a larger cut than five ("12:58"), and both fit
 * with room. The clock and the count beside it share one size.
 */
export function glanceClockWidgetType(time: string): string {
	return time.length > 4 ? "text-[min(36cqi,1em)]" : "text-[min(44cqi,1em)]";
}

/**
 * Apple's small widget: a one-line title, one secondary line, and a single
 * figure set at the foot, so every small widget has the same shape.
 */
export function SmallFace({
	figure,
	figureType,
	subtitle,
	title,
}: {
	figure: ReactNode;
	figureType: string;
	subtitle: ReactNode;
	title: string;
}) {
	return (
		<>
			<span className="flex min-w-0 flex-col">
				<span className={cn("truncate font-semibold text-foreground", W.label)}>
					{title}
				</span>
				<span className={cn("truncate", GLANCE_INK_SECONDARY, W.sub)}>
					{subtitle}
				</span>
			</span>
			{/* The figure sizes to the widget's own width, so "12:58" never clips. */}
			<span
				className={cn(
					"mt-auto block w-full pt-3 [container-type:inline-size]",
					W.big
				)}
			>
				<span
					className={cn(
						"block whitespace-nowrap font-semibold text-foreground tabular-nums leading-none tracking-[-0.03em]",
						figureType
					)}
				>
					{figure}
				</span>
			</span>
		</>
	);
}
