import { useLiteralMessages } from "@ryu/i18n/react";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgentAct,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode, Ref } from "react";
import { GameAgentCard } from "./game-hud.tsx";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { useNow } from "./kitchen-hooks.ts";
import {
	cookProgress,
	type KitchenStation,
	type KitchenTicket,
	roughDuration,
	TICKET_LABELS,
	type TicketAct,
	type TicketState,
	ticketLabel,
	ticketTimer,
} from "./kitchen-model.ts";
import {
	ChefLeading,
	chefActStatus,
	STATION_NAMES,
} from "./kitchen-panel-chef.tsx";
import { NewOrderPane } from "./kitchen-panel-new-order.tsx";
import { ThreadPane } from "./kitchen-panel-thread.tsx";
import { CookRing, STATE_TEXT, StateMark } from "./kitchen-parts.tsx";

export { chefActStatus } from "./kitchen-panel-chef.tsx";

/**
 * The side sheet (the game kit's GameSheet). A chef shows who they are and every ticket they have had
 * (open first), with a composer that places a new order with them; New
 * order picks the chef first; an open ticket is the host's own conversation
 * surface, with a way back to the chef.
 */

export type KitchenPanelView =
	| { kind: "chef"; orders: KitchenTicket[]; station: KitchenStation }
	| { kind: "new"; agentId: string | undefined; stations: KitchenStation[] }
	| {
			kind: "thread";
			station: KitchenStation | undefined;
			thread: InterfaceThread | undefined;
	  };

export function KitchenPanel({
	acts = null,
	actViews = null,
	headingRef,
	onBack,
	onClose,
	onOpen,
	onOrder,
	threadView,
	view,
}: {
	/**
	 * The act layer's view of each ticket (by thread id), when the host
	 * sends asks: words from the acts, no last-update ages, no guessed run.
	 */
	actViews?: ReadonlyMap<string, TicketAct> | null;
	/** The chefs' acts (by agent id), so their status words follow them. */
	acts?: ReadonlyMap<string, InterfaceAgentAct> | null;
	headingRef: Ref<HTMLHeadingElement>;
	/** Set only when the ticket was opened from a chef's pane. */
	onBack: (() => void) | undefined;
	onClose: () => void;
	onOpen: (threadId: string) => void;
	onOrder: (input: { agentId?: string; prompt: string }) => void;
	threadView: ReactNode;
	view: KitchenPanelView;
}) {
	if (view.kind === "chef") {
		return (
			<ChefPane
				act={acts?.get(view.station.agent.id) ?? null}
				actViews={actViews}
				headingRef={headingRef}
				onClose={onClose}
				onOpen={onOpen}
				onOrder={onOrder}
				orders={view.orders}
				station={view.station}
			/>
		);
	}
	if (view.kind === "new") {
		return (
			<NewOrderPane
				acts={acts}
				agentId={view.agentId}
				headingRef={headingRef}
				onClose={onClose}
				onOrder={onOrder}
				stations={view.stations}
			/>
		);
	}
	return (
		<ThreadPane
			headingRef={headingRef}
			onBack={onBack}
			onClose={onClose}
			station={view.station}
			thread={view.thread}
			threadView={threadView}
		/>
	);
}

function ChefPane({
	act,
	actViews,
	headingRef,
	onClose,
	onOpen,
	onOrder,
	orders,
	station,
}: {
	act: InterfaceAgentAct | null;
	actViews: ReadonlyMap<string, TicketAct> | null;
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	onOpen: (threadId: string) => void;
	onOrder: (input: { agentId?: string; prompt: string }) => void;
	orders: KitchenTicket[];
	station: KitchenStation;
}) {
	const tl = useLiteralMessages();
	const now = useNow();
	const { agent } = station;
	const open = orders.filter((order) => order.state !== "served");
	const served = orders.filter((order) => order.state === "served");
	const progress = cookProgress(station.runStartedAt, station.typicalMs, now);
	let status = "Idle";
	if (act) {
		status = chefActStatus(act).label;
	} else if (station.working) {
		status = "Cooking";
	} else if (station.burnt) {
		status = "Has a burnt order";
	}
	return (
		<GameSheet
			data-kitchen-panel=""
			footer={
				<InterfaceComposer
					defaultAgentId={agent.id}
					label={tl("New order for {name}", { name: agent.name })}
					onSubmit={onOrder}
					placeholder={tl("Describe a task for {name}", { name: agent.name })}
					submitLabel="Place order"
				/>
			}
			headingRef={headingRef}
			label={tl("Chef {name}", { name: agent.name })}
			leading={<ChefLeading agentId={agent.id} />}
			onClose={onClose}
			sheetKey={`chef:${agent.id}`}
			subtitle={`${STATION_NAMES[station.kind]} · ${status}`}
			title={agent.name}
		>
			<ScrollArea className="min-h-0 flex-1">
				<GameAgentCard
					description={agent.description}
					stats={[
						{ key: "open", label: "Open", value: open.length },
						{ key: "served", label: "Served", value: served.length },
						{
							key: "usual",
							label: "Usual run",
							value: roughDuration(station.typicalMs),
						},
					]}
				/>
				<div className="flex flex-col gap-6 px-4 py-4">
					{station.working && !actViews ? (
						<div className="flex items-center gap-3 rounded-md bg-muted/60 px-3 py-2.5">
							<CookRing
								fraction={progress.fraction}
								over={progress.over}
								size={28}
								stroke={3}
							/>
							<div className="flex min-w-0 flex-col">
								<span className="font-medium text-sm">
									{progress.over
										? "Taking longer than usual"
										: tl("About {percent}% through", {
												percent: Math.round(progress.fraction * 100),
											})}
								</span>
								<span className="text-[13px] text-muted-foreground">
									{station.typicalFromHistory
										? tl("Estimate from a usual run of about {duration}", {
												duration: roughDuration(station.typicalMs),
											})
										: tl(
												"Estimate from a usual run of about {duration} (no run history yet)",
												{ duration: roughDuration(station.typicalMs) }
											)}
								</span>
							</div>
						</div>
					) : null}
					<TicketSection
						actViews={actViews}
						empty={tl("No open orders with {name}.", { name: agent.name })}
						now={now}
						onOpen={onOpen}
						tickets={open}
						title="Open orders"
					/>
					{served.length > 0 ? (
						<TicketSection
							actViews={actViews}
							now={now}
							onOpen={onOpen}
							tickets={served}
							title="Served"
						/>
					) : null}
				</div>
			</ScrollArea>
		</GameSheet>
	);
}

function TicketSection({
	actViews,
	empty,
	now,
	onOpen,
	tickets,
	title,
}: {
	actViews: ReadonlyMap<string, TicketAct> | null;
	empty?: string;
	now: number;
	onOpen: (threadId: string) => void;
	tickets: KitchenTicket[];
	title: string;
}) {
	return (
		<section aria-label={title} className="flex flex-col gap-1">
			<h3 className="flex items-center gap-2 px-1 font-semibold text-[13px] text-muted-foreground leading-6">
				{title}
				<span className="tabular-nums">{tickets.length}</span>
			</h3>
			{tickets.length === 0 && empty ? (
				<p className="px-1 text-muted-foreground text-sm">{empty}</p>
			) : (
				<ul className="-mx-1 flex flex-col">
					{tickets.map((ticket) => {
						const view = actViews?.get(ticket.id);
						// With acts a ticket nothing moves on is just open (or served).
						const quiet: TicketState =
							ticket.state === "served" ? "served" : "queued";
						const words = actViews
							? (view ?? {
									elapsed: null,
									label: quiet === "served" ? TICKET_LABELS.served : "Open",
								})
							: null;
						const state = view?.state ?? (actViews ? quiet : ticket.state);
						return (
							<li key={ticket.id}>
								<button
									aria-label={ticketLabel(ticket, now, words)}
									className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30"
									onClick={() => onOpen(ticket.id)}
									type="button"
								>
									<StateMark state={state} />
									<span className="min-w-0 flex-1 truncate text-foreground text-sm">
										{ticket.title}
									</span>
									<span
										className={cn(
											"w-18 shrink-0 font-medium text-[13px]",
											STATE_TEXT[state]
										)}
									>
										{words ? words.label : TICKET_LABELS[ticket.state]}
									</span>
									<span className="w-10 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums">
										{words
											? (words.elapsed ?? "")
											: ticketTimer(
													ticket.updatedAt,
													now,
													ticket.state === "cooking"
												)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
