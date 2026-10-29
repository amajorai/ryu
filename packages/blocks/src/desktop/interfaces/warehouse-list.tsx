import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useId } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { pickerLabel } from "./warehouse-diorama.tsx";
import {
	type OrderStage,
	type OrderTab,
	type Picker,
	STAGE_PIPELINE,
	stageLabel,
	type WarehouseOrder,
} from "./warehouse-model.ts";

const STAGE_TAB: Record<OrderStage, OrderTab> = {
	exception: "exceptions",
	packing: "unfulfilled",
	parked: "unfulfilled",
	picking: "unfulfilled",
	ready: "ready",
	received: "unfulfilled",
	shipped: "all",
	stale: "all",
};

/**
 * The warehouse floor as a plain list, for stages without WebGL (and
 * tests): the pickers (each filters the clipboard to their orders) and each
 * stage's orders (each opens on the clipboard), as the diorama shows them.
 */
export function WarehouseList({
	acts,
	fadedIds,
	onPickTab,
	onSelectOrder,
	onSelectPicker,
	orders,
	pickers,
	selectedAgentId,
	selectedOrderId,
}: {
	/**
	 * With the act layer: each picker's row is described by its act
	 * sentence and followed by its `ActStatus`.
	 */
	acts?: {
		sentence: (agentId: string) => string | null;
		status: (agentId: string) => ReactNode;
	};
	fadedIds: ReadonlySet<string>;
	onPickTab: (tab: OrderTab) => void;
	onSelectOrder: (orderId: string) => void;
	onSelectPicker: (agentId: string) => void;
	orders: readonly WarehouseOrder[];
	pickers: readonly Picker[];
	selectedAgentId: string | null;
	selectedOrderId: string | null;
}) {
	const stages: OrderStage[] = acts
		? [...STAGE_PIPELINE, "parked", "exception", "stale"]
		: [...STAGE_PIPELINE, "exception"];
	const named = (stage: OrderStage) => stageLabel(stage, acts !== undefined);
	const baseId = useId();
	const tl = useLiteralMessages();
	return (
		<div
			className="absolute inset-0 overflow-auto bg-(--gk-backdrop) px-4 pt-24 pb-28"
			data-testid="warehouse-list"
		>
			<div className="mx-auto flex max-w-3xl flex-col gap-4">
				<section
					aria-label="Pickers"
					className={cn(GAME_PLATE, "flex flex-col gap-2 p-4")}
				>
					<h3 className="gk-display text-[17px]">Pickers</h3>
					<ul className={acts ? "flex flex-col gap-2" : "flex flex-wrap gap-2"}>
						{pickers.map((picker) => {
							const sentence = acts?.sentence(picker.agent.id) ?? null;
							const describedBy = `${baseId}-${picker.agent.id}`;
							return (
								<li
									className={
										acts ? "flex flex-wrap items-center gap-2" : undefined
									}
									key={picker.agent.id}
								>
									{sentence ? (
										<span className="sr-only" id={describedBy}>
											{sentence}
										</span>
									) : null}
									<button
										aria-describedby={sentence ? describedBy : undefined}
										aria-label={
											acts
												? tl("{name}. Show their orders", {
														name: picker.agent.name,
													})
												: pickerLabel(picker)
										}
										aria-pressed={selectedAgentId === picker.agent.id}
										className={cn(
											GAME_FOCUS,
											"rounded-full border-(--gk-plate-sunk) border-2 px-3 py-1 font-semibold text-[13px] hover:bg-(--gk-plate-sunk) aria-pressed:bg-(--gk-accent) aria-pressed:text-(--gk-accent-ink)"
										)}
										data-act-agent={sentence ? picker.agent.id : undefined}
										data-picker-tag={picker.agent.id}
										onClick={() => onSelectPicker(picker.agent.id)}
										type="button"
									>
										{picker.agent.name}
									</button>
									{acts?.status(picker.agent.id) ?? null}
								</li>
							);
						})}
					</ul>
				</section>
				{stages.map((stage) => {
					const here = orders.filter((order) => order.stage === stage);
					if (here.length === 0) {
						return null;
					}
					return (
						<section
							aria-label={named(stage)}
							className={cn(GAME_PLATE, "flex flex-col gap-2 p-4")}
							key={stage}
						>
							<button
								aria-label={tl(
									"{stageLabel}: {count, plural, one {{countText} order} other {{countText} orders}}. Show them on the clipboard",
									{
										count: here.length,
										countText: String(here.length),
										stageLabel: named(stage),
									}
								)}
								className={cn(
									GAME_FOCUS,
									"gk-display w-fit rounded-lg px-1 text-start text-[17px]"
								)}
								onClick={() => onPickTab(STAGE_TAB[stage])}
								type="button"
							>
								{named(stage)} {here.length}
							</button>
							<ul className="flex flex-wrap gap-2">
								{here.map((order) => (
									<li key={order.id}>
										<button
											aria-current={
												selectedOrderId === order.id ? "true" : undefined
											}
											aria-label={tl("Order {number}, {stageLabel}", {
												number: order.number,
												stageLabel: named(order.stage),
											})}
											className={cn(
												GAME_FOCUS,
												"flex flex-col rounded-xl border-(--gk-plate-sunk) border-2 px-3 py-1.5 text-start text-[13px] hover:bg-(--gk-plate-sunk)",
												fadedIds.has(order.id) && "opacity-30"
											)}
											data-order-box={order.id}
											onClick={() => onSelectOrder(order.id)}
											type="button"
										>
											<span className="font-semibold tabular-nums">
												{order.number}
											</span>
											<span className="max-w-48 truncate text-(--gk-ink-muted)">
												{order.thread.title}
											</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					);
				})}
			</div>
		</div>
	);
}
