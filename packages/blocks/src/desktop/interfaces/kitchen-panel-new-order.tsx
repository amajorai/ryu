import { useLiteralMessages } from "@ryu/i18n/react";
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { type Ref, useState } from "react";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { ChefAvatar } from "./kitchen-avatar.tsx";
import type { KitchenStation, TicketState } from "./kitchen-model.ts";
import { chefActStatus, STATION_NAMES } from "./kitchen-panel-chef.tsx";
import { STATE_TEXT, StateMark } from "./kitchen-parts.tsx";

export function NewOrderPane({
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
	const tl = useLiteralMessages();
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
						label={tl("New order for {name}", { name: chosen.agent.name })}
						onSubmit={onOrder}
						placeholder={tl("Describe a task for {name}", {
							name: chosen.agent.name,
						})}
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
	const tl = useLiteralMessages();
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
						{open === 0
							? "No open orders"
							: tl("{open} open", { open: String(open) })}
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
