import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { GripVertical, X } from "lucide-react";
import { motion } from "motion/react";
import type {
	KeyboardEvent,
	ReactNode,
	PointerEvent as ReactPointerEvent,
	Ref,
} from "react";
import {
	type LayoutItem,
	nextWidgetSize,
	WIDGET_SIZE_NAMES,
	WIDGET_SIZE_SHORT,
	type WidgetKind,
	widgetSpec,
} from "./dashboard-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * Column spans on the 12-column grid. Quarters keep every widget edge on the
 * same four column lines, so rows line up however the viewer mixes sizes.
 * Narrower walls fold quarters into halves, then everything into one column
 * (number tiles stay two-up on phones).
 */
const SPAN: Record<WidgetKind, Record<LayoutItem["size"], string>> = {
	panel: {
		full: "col-span-12",
		l: "col-span-12 @min-[1080px]/dash:col-span-9",
		m: "col-span-12 @min-[1080px]/dash:col-span-6",
		s: "col-span-12 @min-[640px]/dash:col-span-6 @min-[1080px]/dash:col-span-3",
	},
	stat: {
		full: "col-span-12",
		l: "col-span-12",
		m: "col-span-12 @min-[640px]/dash:col-span-6",
		s: "col-span-6 @min-[640px]/dash:col-span-3",
	},
};

/** Tiles take one 84px row; panels take three (276px with the gaps). */
const ROWS: Record<WidgetKind, string> = {
	panel: "row-span-3",
	stat: "row-span-1",
};

export function widgetSpanClass(item: LayoutItem): string {
	const { kind } = widgetSpec(item.id);
	return cn(SPAN[kind][item.size], ROWS[kind]);
}

const EASE = [0.2, 0, 0, 1] as const;

export interface WidgetEditProps {
	count: number;
	dragging: boolean;
	index: number;
	onCycleSize: () => void;
	onMove: (toIndex: number) => void;
	onRemove: () => void;
	onStartDrag: (event: ReactPointerEvent<HTMLElement>) => void;
}

function moveTarget(
	key: string,
	index: number,
	count: number
): number | undefined {
	switch (key) {
		case "ArrowLeft":
		case "ArrowUp":
			return index - 1;
		case "ArrowRight":
		case "ArrowDown":
			return index + 1;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return undefined;
	}
}

/** The edit-mode handle: drag it, or focus it and use the arrow keys. */
function DragHandle({
	count,
	index,
	onMove,
	onStartDrag,
	title,
}: Pick<WidgetEditProps, "count" | "index" | "onMove" | "onStartDrag"> & {
	title: string;
}) {
	const tl = useLiteralMessages();
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const target = moveTarget(event.key, index, count);
		if (target === undefined) {
			return;
		}
		event.preventDefault();
		if (target >= 0 && target < count && target !== index) {
			onMove(target);
		}
	};
	return (
		<Button
			aria-describedby="dashboard-move-hint"
			aria-label={tl("Move {title}, position {position} of {count}", {
				count,
				position: index + 1,
				title,
			})}
			className="-ms-1.5 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
			onKeyDown={onKeyDown}
			onPointerDown={onStartDrag}
			size="icon-xs"
			type="button"
			variant="ghost"
		>
			<GripVertical aria-hidden="true" />
		</Button>
	);
}

function EditControls({
	item,
	onCycleSize,
	onRemove,
	title,
}: {
	item: LayoutItem;
	onCycleSize: () => void;
	onRemove: () => void;
	title: string;
}) {
	const tl = useLiteralMessages();
	const next = nextWidgetSize(item.id, item.size);
	const size = WIDGET_SIZE_NAMES[item.size];
	const nextSize = WIDGET_SIZE_NAMES[next];
	return (
		<span className="ms-auto flex shrink-0 items-center gap-1">
			<Button
				aria-label={tl("Resize {title}: {size}, change to {nextSize}", {
					nextSize,
					size,
					title,
				})}
				className="min-w-9 px-1.5 font-medium tabular-nums"
				onClick={onCycleSize}
				radius="small"
				size="xs"
				title={tl("Size: {size}. Click for {nextSize}.", { nextSize, size })}
				type="button"
				variant="outline"
			>
				{WIDGET_SIZE_SHORT[item.size]}
			</Button>
			<Button
				aria-label={tl("Remove {title}", { title })}
				className="-me-1.5 text-muted-foreground"
				onClick={onRemove}
				size="icon-xs"
				title="Remove widget"
				type="button"
				variant="ghost"
			>
				<X aria-hidden="true" />
			</Button>
		</span>
	);
}

/**
 * One widget on the grid: a quiet bordered frame with a single header line
 * (title, then a right-aligned figure) over its content. In edit mode the
 * header carries the drag handle, the size control, and remove; the content
 * dims and stops taking clicks so a drag never opens a thread.
 */
export function DashboardWidget({
	children,
	edit,
	item,
	meta,
	ref,
	title,
}: {
	children: ReactNode;
	/** Present only while the dashboard is in edit mode. */
	edit: WidgetEditProps | null;
	item: LayoutItem;
	meta?: ReactNode;
	ref?: Ref<HTMLElement>;
	title: string;
}) {
	const reduceMotion = useReducedMotion();
	const { kind } = widgetSpec(item.id);
	const titleId = `dashboard-widget-${item.id}`;
	const header = (
		<div
			className={cn(
				"flex min-w-0 items-center gap-2",
				kind === "panel" ? "h-11 shrink-0 px-4" : "h-6"
			)}
		>
			{edit ? (
				<DragHandle
					count={edit.count}
					index={edit.index}
					onMove={edit.onMove}
					onStartDrag={edit.onStartDrag}
					title={title}
				/>
			) : null}
			<h2
				className={cn(
					"min-w-0 truncate text-sm",
					kind === "panel"
						? "font-semibold text-foreground"
						: "text-muted-foreground"
				)}
				id={titleId}
			>
				{title}
			</h2>
			{edit ? (
				<EditControls
					item={item}
					onCycleSize={edit.onCycleSize}
					onRemove={edit.onRemove}
					title={title}
				/>
			) : (
				meta && (
					<span className="ms-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">
						{meta}
					</span>
				)
			)}
		</div>
	);
	return (
		<motion.section
			animate={{ opacity: 1, scale: 1 }}
			aria-labelledby={titleId}
			className={cn(
				"relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground",
				kind === "stat" && "px-4 py-3",
				widgetSpanClass(item),
				edit?.dragging &&
					"z-10 border-ring shadow-foreground/10 shadow-lg ring-1 ring-ring"
			)}
			data-size={item.size}
			data-widget-id={item.id}
			exit={{ opacity: 0, scale: 0.98 }}
			initial={reduceMotion ? false : { opacity: 0, scale: 0.98 }}
			layout={reduceMotion ? false : "position"}
			ref={ref}
			transition={{ duration: 0.2, ease: EASE }}
		>
			{header}
			<div
				className={cn(
					"flex min-h-0 flex-1 flex-col transition-opacity duration-150",
					edit && "pointer-events-none select-none opacity-55"
				)}
				inert={edit !== null}
			>
				{children}
			</div>
		</motion.section>
	);
}
