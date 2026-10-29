import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { type KeyboardEvent, useRef } from "react";
import {
	TICKET_VIEWS,
	type TicketViewId,
	ticketCountLabel,
} from "./tickets-model.ts";

/**
 * The views panel: Zendesk's saved views with their counts. Arrow keys move
 * between views; the selected one is the panel's single tab stop.
 */
export function TicketsViewsPanel({
	counts,
	loading,
	onSelect,
	selectedId,
}: {
	counts: Record<TicketViewId, number>;
	loading: boolean;
	onSelect: (viewId: TicketViewId) => void;
	selectedId: TicketViewId;
}) {
	const items = useRef(new Map<TicketViewId, HTMLButtonElement>());

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		const index = TICKET_VIEWS.findIndex((view) => view.id === selectedId);
		let next = -1;
		if (event.key === "ArrowDown") {
			next = Math.min(index + 1, TICKET_VIEWS.length - 1);
		} else if (event.key === "ArrowUp") {
			next = Math.max(index - 1, 0);
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = TICKET_VIEWS.length - 1;
		}
		const view = TICKET_VIEWS[next];
		if (!view) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		onSelect(view.id);
		items.current.get(view.id)?.focus();
	};

	return (
		<nav
			aria-label="Ticket views"
			className="flex w-60 shrink-0 flex-col border-border border-r bg-sidebar text-sidebar-foreground"
			data-testid="tickets-views"
		>
			<div className="flex h-12 shrink-0 items-center px-4">
				<h2 className="font-semibold text-sm">Views</h2>
			</div>
			<ul className="flex flex-col gap-px px-2" onKeyDown={onKeyDown}>
				{TICKET_VIEWS.map((view) => {
					const selected = view.id === selectedId;
					const count = counts[view.id];
					return (
						<li key={view.id}>
							<button
								aria-current={selected ? "page" : undefined}
								aria-label={`${view.label}, ${ticketCountLabel(count)}`}
								className={cn(
									"flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
									"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
									selected &&
										"bg-sidebar-accent font-medium text-sidebar-accent-foreground"
								)}
								data-testid={`tickets-view-${view.id}`}
								onClick={() => onSelect(view.id)}
								ref={(element) => {
									if (element) {
										items.current.set(view.id, element);
									} else {
										items.current.delete(view.id);
									}
								}}
								tabIndex={selected ? 0 : -1}
								type="button"
							>
								<span className="min-w-0 flex-1 truncate">{view.label}</span>
								{loading ? (
									<Skeleton className="h-3 w-4" />
								) : (
									<span
										aria-hidden="true"
										className={cn(
											"text-xs tabular-nums",
											selected
												? "text-sidebar-accent-foreground"
												: "text-sidebar-foreground/60",
											view.id === "urgent" &&
												count > 0 &&
												"font-semibold text-destructive"
										)}
									>
										{count}
									</span>
								)}
							</button>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}

/** The views panel collapsed into one select for narrow widths. */
export function TicketsViewSelect({
	counts,
	onSelect,
	selectedId,
}: {
	counts: Record<TicketViewId, number>;
	onSelect: (viewId: TicketViewId) => void;
	selectedId: TicketViewId;
}) {
	return (
		<NativeSelect
			aria-label="View"
			className="min-w-0 max-w-full"
			data-testid="tickets-view-select"
			onChange={(event) => {
				const view = TICKET_VIEWS.find(
					(option) => option.id === event.target.value
				);
				if (view) {
					onSelect(view.id);
				}
			}}
			size="sm"
			value={selectedId}
		>
			{TICKET_VIEWS.map((view) => (
				<NativeSelectOption key={view.id} value={view.id}>
					{`${view.label} (${counts[view.id]})`}
				</NativeSelectOption>
			))}
		</NativeSelect>
	);
}
