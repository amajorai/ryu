// The frame around every widget on the grid: a shadcn Card with a draggable
// header (title + actions) and a body rendered from the fixed widget catalog.
// The header carries the `data-widget-drag-handle` attribute react-grid-layout
// uses as its drag handle. Notion-style chrome: the grip and the actions menu stay
// in the DOM (so the drag-handle selector always resolves) but fade in only on
// hover via the Card's `group` — the whole header is draggable regardless of the
// grip's opacity. The actions menu opts out of dragging with `nodrag nopan`.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Card, CardContent } from "@ryu/ui/components/card.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	GripVerticalIcon,
	MoreVerticalIcon,
	RefreshCwIcon,
	Trash2Icon,
} from "lucide-react";
import { useState } from "react";
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
	interaction,
	motionEnabled = true,
}: {
	widget: Widget;
	/** Live value (from SSE) or the cached last value. */
	value: unknown;
	error?: string | null;
	onRefresh: () => void;
	onRemove: () => void;
	/** The active grid/canvas gesture, used for tactile feedback on the card. */
	interaction?: "drag" | "resize";
	/** App + OS motion preference resolved by the owning surface. */
	motionEnabled?: boolean;
}) {
	const tl = useLiteralMessages();
	const [actionsOpen, setActionsOpen] = useState(false);

	return (
		<Card
			appearance="dashboard-widget"
			className="group flex h-full flex-col overflow-hidden"
			data-dashboard-interaction={interaction ?? "idle"}
			interaction={interaction}
			motionEnabled={motionEnabled}
		>
			<div
				className="flex cursor-grab select-none items-center gap-1.5 border-b bg-muted/20 px-3 py-2 active:cursor-grabbing"
				data-widget-drag-handle=""
			>
				<GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
				<span
					className="flex-1 truncate font-medium text-sm tracking-tight"
					title={widget.title || "Untitled"}
				>
					{widget.title || "Untitled"}
				</span>
				{/* `nodrag nopan` are React Flow's opt-out classes. In DashboardCanvas
				    each card is a node, and without them d3-drag claims (and stops)
				    the mousedown the menu trigger opens on, so the menu never opens
				    and a press-and-move drags the widget. The grid view honours the
				    same class through its drag `cancel` selector. The hover reveal
				    lives here because the shared Button owns its own effects; its
				    `ghost-muted` variant keeps the trigger's muted resting color. */}
				<div
					className={cn(
						"nodrag nopan opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
						actionsOpen && "opacity-100"
					)}
					data-widget-actions=""
				>
					<DropdownMenu onOpenChange={setActionsOpen}>
						<DropdownMenuTrigger
							aria-expanded={actionsOpen}
							aria-label={tl("Widget actions for {widgetTitle}", {
								widgetTitle: widget.title || "Untitled",
							})}
							onClick={() => setActionsOpen(true)}
							onPointerDown={(event) => event.stopPropagation()}
							render={<Button size="icon-sm" variant="ghost-muted" />}
						>
							<MoreVerticalIcon className="size-4" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={() => onRefresh()}>
								<RefreshCwIcon className="size-4" /> Refresh
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => onRemove()}
								variant="destructive"
							>
								<Trash2Icon className="size-4" /> Remove
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<CardContent className="min-h-0 flex-1 overflow-hidden" inset="widget">
				{error ? (
					<div className="flex h-full items-center justify-center text-center text-status-destructive text-xs">
						{error}
					</div>
				) : (
					<WidgetBody value={value} widget={widget} />
				)}
			</CardContent>
		</Card>
	);
}
