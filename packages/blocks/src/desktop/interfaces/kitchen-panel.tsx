import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgentAct,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { threadStatus } from "@ryuhq/protocol/interfaces";
import { type ReactNode, type Ref, useState } from "react";
import { GameAgentCard } from "./game-hud.tsx";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { ChefAvatar } from "./kitchen-avatar.tsx";
import { useNow } from "./kitchen-hooks.ts";
import {
	cookProgress,
	type KitchenStation,
	type KitchenTicket,
	roughDuration,
	TICKET_LABELS,
	TICKET_STATE,
	type TicketAct,
	type TicketState,
	ticketLabel,
	ticketTimer,
} from "./kitchen-model.ts";
import { CookRing, STATE_TEXT, StateMark } from "./kitchen-parts.tsx";

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

const STATION_NAMES = {
	board: "Chopping board",
	grill: "Grill",
	stove: "Stove",
} as const;

/** The chef's face in a sheet header. */
function ChefLeading({ agentId }: { agentId: string }) {
	return (
		<span className="grid size-11 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
			<ChefAvatar agentId={agentId} size={34} />
		</span>
	);
}

/** A chef's status words and mark from its act (the line and its pane). */
export function chefActStatus(act: InterfaceAgentAct): {
	label: string;
	state: TicketState;
} {
	switch (act.act) {
		case "asking":
			return { label: "Needs you", state: "needs" };
		case "working":
			return { label: act.stalled ? "Stalled?" : "Cooking", state: "cooking" };
		case "blocked":
			return act.blockers[0]?.kind === "interrupted"
				? { label: "Pulled", state: "burnt" }
				: { label: "Burnt order", state: "burnt" };
		case "limited":
			return { label: "86'd", state: "limited" };
		case "delivering":
			return { label: "Dish ready", state: "ready" };
		case "waiting":
			return { label: "Waiting", state: "queued" };
		default:
			return { label: "Idle", state: "served" };
	}
}

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
					label={`New order for ${agent.name}`}
					onSubmit={onOrder}
					placeholder={`Describe a task for ${agent.name}`}
					submitLabel="Place order"
				/>
			}
			headingRef={headingRef}
			label={`Chef ${agent.name}`}
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
										: `About ${Math.round(progress.fraction * 100)}% through`}
								</span>
								<span className="text-[13px] text-muted-foreground">
									Estimate from a usual run of about{" "}
									{roughDuration(station.typicalMs)}
									{station.typicalFromHistory ? "" : " (no run history yet)"}
								</span>
							</div>
						</div>
					) : null}
					<TicketSection
						actViews={actViews}
						empty={`No open orders with ${agent.name}.`}
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

function NewOrderPane({
	acts,
	agentId,
	headingRef,
	onClose,
	onOrder,
	stations,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct> | null;
	agentId: string | undefined;
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	onOrder: (input: { agentId?: string; prompt: string }) => void;
	stations: KitchenStation[];
}) {
	const [picked, setPicked] = useState(agentId);
	const chosen =
		stations.find((station) => station.agent.id === picked) ?? stations[0];
	return (
		<GameSheet
			data-kitchen-panel=""
			footer={
				chosen ? (
					<InterfaceComposer
						defaultAgentId={chosen.agent.id}
						key={chosen.agent.id}
						label={`New order for ${chosen.agent.name}`}
						onSubmit={onOrder}
						placeholder={`Describe a task for ${chosen.agent.name}`}
						submitLabel="Place order"
					/>
				) : undefined
			}
			headingRef={headingRef}
			label="New order"
			onClose={onClose}
			sheetKey="new"
			subtitle="Pick a chef, then describe the task"
			title="New order"
		>
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-1 px-4 py-4">
					<h3
						className="flex items-center gap-2 px-1 font-semibold text-[13px] text-muted-foreground leading-6"
						id="kitchen-new-order-chef"
					>
						Chef
					</h3>
					{stations.length === 0 ? (
						<p className="px-1 text-muted-foreground text-sm">
							There are no agents to take orders yet.
						</p>
					) : (
						<ul
							aria-labelledby="kitchen-new-order-chef"
							className="-mx-1 flex flex-col gap-0.5"
						>
							{stations.map((station) => (
								<LineRow
									act={acts?.get(station.agent.id) ?? null}
									key={station.agent.id}
									onPick={setPicked}
									selected={station.agent.id === chosen?.agent.id}
									station={station}
								/>
							))}
						</ul>
					)}
				</div>
			</ScrollArea>
		</GameSheet>
	);
}

/** One chef on the line: pick who takes the new order. */
function LineRow({
	act,
	onPick,
	selected,
	station,
}: {
	act: InterfaceAgentAct | null;
	onPick: (agentId: string) => void;
	selected: boolean;
	station: KitchenStation;
}) {
	let status = "Idle";
	let state: TicketState = "served";
	if (act) {
		({ label: status, state } = chefActStatus(act));
	} else if (station.working) {
		status = "Cooking";
		state = "cooking";
	} else if (station.burnt) {
		status = "Burnt order";
		state = "burnt";
	}
	const open = station.orders.length;
	return (
		<li>
			<button
				aria-pressed={selected}
				className={cn(
					"flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50",
					selected && "bg-accent shadow-[inset_2px_0_0_var(--ring)]"
				)}
				onClick={() => onPick(station.agent.id)}
				type="button"
			>
				<ChefAvatar agentId={station.agent.id} size={24} />
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-medium text-foreground text-sm leading-5">
						{station.agent.name}
					</span>
					<span className="truncate text-[13px] text-muted-foreground leading-5">
						{STATION_NAMES[station.kind]} ·{" "}
						{open === 0 ? "No open orders" : `${open} open`}
					</span>
				</span>
				<span
					className={cn(
						"flex shrink-0 items-center gap-1.5 font-medium text-[13px]",
						state === "served" ? "text-muted-foreground" : STATE_TEXT[state]
					)}
				>
					{state === "served" ? null : <StateMark state={state} />}
					{status}
				</span>
			</button>
		</li>
	);
}

function ThreadPane({
	headingRef,
	onBack,
	onClose,
	station,
	thread,
	threadView,
}: {
	headingRef: Ref<HTMLHeadingElement>;
	onBack: (() => void) | undefined;
	onClose: () => void;
	station: KitchenStation | undefined;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const state = thread ? TICKET_STATE[threadStatus(thread)] : null;
	const backLabel = station
		? `Back to ${station.agent.name}`
		: "Back to the kitchen";
	return (
		<GameSheet
			backLabel={backLabel}
			closeLabel="Close order"
			data-kitchen-panel=""
			headingRef={headingRef}
			label={`Order: ${thread?.title ?? "Conversation"}`}
			leading={
				station && !onBack ? (
					<ChefLeading agentId={station.agent.id} />
				) : undefined
			}
			onBack={onBack}
			onClose={onClose}
			sheetKey={`thread:${thread?.id ?? ""}`}
			subtitle={
				<>
					{state ? <StateMark state={state} /> : null}
					<span>{state ? TICKET_LABELS[state] : "Starting"}</span>
					{station ? <span>· {station.agent.name}</span> : null}
				</>
			}
			title={thread?.title.trim() || "New order"}
		>
			<div className="min-h-0 flex-1">{threadView}</div>
		</GameSheet>
	);
}
