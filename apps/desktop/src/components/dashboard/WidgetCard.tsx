// The frame around every widget on the grid: a shadcn Card with a draggable
// header (title + actions) and a body rendered from the fixed widget catalog.
// The header carries the `widget-drag-handle` class react-grid-layout uses as its
// drag handle. Notion-style chrome: the grip and the actions menu stay in the DOM
// (so the drag-handle selector always resolves) but fade in only on hover via the
// Card's `group` — the whole header is draggable regardless of the grip's opacity.

import { buttonVariants } from "@ryu/ui/components/button";
import { Card, CardContent } from "@ryu/ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import {
	GripVerticalIcon,
	MoreVerticalIcon,
	RefreshCwIcon,
	Trash2Icon,
} from "lucide-react";
import type { Widget } from "@/src/lib/api/dashboard.ts";
import { widgetDefinition } from "./widgets/registry.tsx";

function WidgetBody({ widget, value }: { widget: Widget; value: unknown }) {
	const definition = widgetDefinition(widget.kind);
	if (!definition) {
		return null;
	}
	return definition.render({ widget, value });
}

export function WidgetCard({
	widget,
	value,
	error,
	onRefresh,
	onRemove,
}: {
	widget: Widget;
	/** Live value (from SSE) or the cached last value. */
	value: unknown;
	error?: string | null;
	onRefresh: () => void;
	onRemove: () => void;
}) {
	return (
		<Card className="group flex h-full flex-col gap-0 overflow-hidden rounded-2xl border-border/60 py-0 shadow-sm transition-shadow duration-200 hover:shadow-md">
			<div className="widget-drag-handle /50 flex cursor-grab items-center gap-1.5 border-b bg-muted/20 px-3 py-2 active:cursor-grabbing">
				<GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
				<span className="flex-1 truncate font-semibold text-sm tracking-tight">
					{widget.title || "Untitled"}
				</span>
				<DropdownMenu>
					<DropdownMenuTrigger
						className={buttonVariants({
							variant: "ghost",
							size: "icon",
							className:
								"size-6 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
						})}
						onPointerDown={(e) => e.stopPropagation()}
					>
						<MoreVerticalIcon className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => onRefresh()}>
							<RefreshCwIcon className="size-4" /> Refresh
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => onRemove()} variant="destructive">
							<Trash2Icon className="size-4" /> Remove
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<CardContent className="min-h-0 flex-1 overflow-hidden p-3">
				{error ? (
					<div className="flex h-full items-center justify-center text-center text-destructive text-xs">
						{error}
					</div>
				) : (
					<WidgetBody value={value} widget={widget} />
				)}
			</CardContent>
		</Card>
	);
}
