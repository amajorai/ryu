import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useId } from "react";
import { ActStatus } from "./interface-ask-card.tsx";
import { ChefAvatar } from "./kitchen-avatar.tsx";
import { useNow } from "./kitchen-hooks.ts";
import {
	cookProgress,
	type KitchenService,
	plural,
	TICKET_LABELS,
	ticketLabel,
} from "./kitchen-model.ts";
import { CookRing, STATE_TEXT, StateMark } from "./kitchen-parts.tsx";

const STATION_LABEL = {
	board: "Chopping board",
	grill: "Grill",
	stove: "Stove",
} as const;

/** The act layer for the line's rows, when the host sends asks. */
export interface KitchenLineActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
}

/**
 * The line without WebGL (or before it starts): each station as a row with
 * its chef, what they are doing and their ready dishes, so everything the
 * scene shows is still reachable.
 */
export function KitchenLine({
	actLayer = null,
	onSelectChef,
	onServe,
	service,
}: {
	/** With acts each row says its act and carries its answer buttons. */
	actLayer?: KitchenLineActs | null;
	onSelectChef: (agentId: string) => void;
	onServe: (threadId: string) => void;
	service: KitchenService;
}) {
	const now = useNow();
	const baseId = useId();
	const tl = useLiteralMessages();
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
			<section aria-label="The line" className="flex flex-col gap-2">
				<h2 className="font-medium text-[13px] text-muted-foreground">
					The line
				</h2>
				<ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
					{service.stations.map((station) => {
						const progress = cookProgress(
							station.runStartedAt,
							station.typicalMs,
							now
						);
						let status = "Idle";
						let tone = "text-muted-foreground";
						if (station.working) {
							status = progress.over
								? "Cooking, longer than usual"
								: `Cooking, ~${Math.round(progress.fraction * 100)}% (estimate)`;
							tone = STATE_TEXT.cooking;
						} else if (station.burnt) {
							status = "Burnt order";
							tone = STATE_TEXT.burnt;
						}
						const act = actLayer?.acts.get(station.agent.id);
						const describedBy = `${baseId}-${station.index}`;
						return (
							<li key={station.agent.id}>
								{act ? (
									<span hidden id={describedBy}>
										{act.ariaLabel}
									</span>
								) : null}
								<button
									aria-describedby={act ? describedBy : undefined}
									className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
									onClick={() => onSelectChef(station.agent.id)}
									type="button"
								>
									<ChefAvatar agentId={station.agent.id} size={28} />
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate font-medium text-sm">
											{station.agent.name}
										</span>
										<span className="truncate text-[13px] text-muted-foreground">
											{STATION_LABEL[station.kind]} ·{" "}
											{plural(station.orders.length, "open order")}
											{!act && station.burnt && station.working ? (
												<span className={STATE_TEXT.burnt}> · 1 burnt</span>
											) : null}
										</span>
									</span>
									{act ? null : (
										<span
											className={cn(
												"flex items-center gap-1.5 font-medium text-[13px]",
												tone
											)}
										>
											{station.working ? (
												<CookRing
													fraction={progress.fraction}
													over={progress.over}
													size={14}
												/>
											) : null}
											{status}
										</span>
									)}
								</button>
								{act && actLayer ? (
									<div className="px-3 ps-[52px] pb-2.5">
										<ActStatus
											act={act}
											clock={actLayer.clock}
											nowMs={actLayer.nowMs}
											onAsk={actLayer.onAsk}
											onBlocker={actLayer.onBlocker}
											snapshot={actLayer.snapshot}
										/>
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			</section>
			{service.dishes.length > 0 && !actLayer ? (
				<section aria-label="On the pass" className="flex flex-col gap-2">
					<h2 className="font-medium text-[13px] text-muted-foreground">
						On the pass
					</h2>
					<ul className="flex flex-wrap gap-2">
						{service.dishes.map((dish) => (
							<li key={dish.ticket.id}>
								<button
									aria-label={tl("Serve {ticket}", {
										ticket: ticketLabel(dish.ticket, now),
									})}
									className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/30"
									onClick={() => onServe(dish.ticket.id)}
									type="button"
								>
									<StateMark state="ready" />
									<span className="max-w-48 truncate">{dish.ticket.title}</span>
									<span className="sr-only">{TICKET_LABELS.ready}</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}
