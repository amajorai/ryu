import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { Plus, Sprout, Warehouse } from "lucide-react";
import { useId } from "react";
import {
	cropLabel,
	cropTitle,
	type FarmField,
	plotLabel,
	STAGE_NAMES,
} from "./farm-model.ts";
import { PlantGlyph } from "./farm-plants.tsx";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { ActStatus } from "./interface-ask-card.tsx";

/** The act layer for the plots' rows, when the host sends asks. */
export interface FarmListActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
}

/**
 * The farm as a plain list, for stages without WebGL (and tests): every
 * field, plot and crop the diorama shows, as the same controls (a plot
 * opens its sheet, a crop opens its conversation, the barn lists all).
 */
export function FarmList({
	actLayer = null,
	activeThreadId,
	emptyFarm,
	fields,
	onOpenBarn,
	onOpenCrop,
	onOpenPlot,
	selectedPlotId,
	totalCrops,
}: {
	/** With acts each farmer's row says its act and carries its buttons. */
	actLayer?: FarmListActs | null;
	activeThreadId: string | null;
	emptyFarm: boolean;
	fields: readonly FarmField[];
	onOpenBarn: () => void;
	onOpenCrop: (threadId: string) => void;
	onOpenPlot: (plotId: string | null) => void;
	selectedPlotId: string | null;
	totalCrops: number;
}) {
	const tl = useLiteralMessages();
	const baseId = useId();
	return (
		<div
			className={cn(
				"absolute inset-0 overflow-auto bg-(--gk-backdrop) px-4 pb-28",
				// With acts the blind-spot caption sits under the title plate.
				// (on a phone with the summary on its own plate too).
				actLayer ? "pt-48" : "pt-24"
			)}
			data-testid="farm-list"
		>
			<div className="mx-auto flex max-w-3xl flex-col gap-4">
				<button
					aria-label={tl(
						"Open the barn: {count, plural, one {{crops} crop} other {{crops} crops}}",
						{
							count: totalCrops,
							crops: String(totalCrops),
						}
					)}
					className={cn(
						GAME_PLATE,
						GAME_FOCUS,
						"gk-display flex h-11 w-fit items-center gap-2 px-4 text-[15px]"
					)}
					data-testid="farm-barn"
					onClick={onOpenBarn}
					type="button"
				>
					<Warehouse aria-hidden="true" className="size-5" />
					Barn
				</button>
				{fields.map((field) => (
					<section
						aria-label={field.name}
						className={cn(GAME_PLATE, "flex flex-col gap-3 p-4")}
						key={field.id}
					>
						<h2 className="gk-display text-[17px]">{field.name}</h2>
						<ul className="flex flex-col gap-3">
							{field.plots.map((plot) => {
								const act = plot.agent
									? actLayer?.acts.get(plot.agent.id)
									: undefined;
								const describedBy = `${baseId}-${plot.id}`;
								return (
									<li className="flex flex-col gap-2" key={plot.id}>
										{act ? (
											<span hidden id={describedBy}>
												{act.ariaLabel}
											</span>
										) : null}
										<div className="flex items-center gap-2">
											<button
												aria-current={
													selectedPlotId === plot.id ? "true" : undefined
												}
												aria-describedby={act ? describedBy : undefined}
												aria-label={plotLabel(plot)}
												className={cn(
													GAME_FOCUS,
													"gk-display rounded-lg px-2 py-1 text-[15px] hover:bg-(--gk-plate-sunk)"
												)}
												data-testid="farm-plot"
												onClick={() => onOpenPlot(emptyFarm ? null : plot.id)}
												type="button"
											>
												{plot.name}
											</button>
											{emptyFarm ? (
												<button
													className={cn(
														GAME_PLATE,
														GAME_FOCUS,
														"flex h-9 items-center gap-1.5 px-3 font-semibold text-[13px]"
													)}
													data-testid="farm-plant-seed"
													onClick={() => onOpenPlot(null)}
													type="button"
												>
													<Sprout aria-hidden="true" className="size-4" />
													Plant a seed
												</button>
											) : (
												<button
													aria-label={tl("Plant a seed in {name}'s plot", {
														name: plot.name,
													})}
													className={cn(
														GAME_FOCUS,
														"grid size-8 place-items-center rounded-full hover:bg-(--gk-plate-sunk)"
													)}
													data-testid="farm-plant-seed"
													onClick={() => onOpenPlot(plot.id)}
													title="Plant a seed"
													type="button"
												>
													<Plus aria-hidden="true" className="size-4" />
												</button>
											)}
										</div>
										{plot.crops.length > 0 ? (
											<ul className="flex flex-wrap gap-2">
												{plot.crops.map((crop) => (
													<li key={crop.thread.id}>
														<button
															aria-current={
																activeThreadId === crop.thread.id
																	? "true"
																	: undefined
															}
															aria-label={cropLabel(crop, plot.name)}
															className={cn(
																GAME_FOCUS,
																"flex items-center gap-2 rounded-xl border-(--gk-plate-sunk) border-2 px-2.5 py-1.5 text-start text-[13px] hover:bg-(--gk-plate-sunk)"
															)}
															data-stage={crop.stage}
															data-testid="farm-crop"
															onClick={() => onOpenCrop(crop.thread.id)}
															type="button"
														>
															<PlantGlyph
																className="size-7 shrink-0"
																fruit={crop.fruit}
																stage={crop.stage}
															/>
															<span className="flex flex-col">
																<span className="font-semibold">
																	{cropTitle(crop.thread)}
																</span>
																<span className="text-(--gk-ink-muted)">
																	{STAGE_NAMES[crop.stage]}
																</span>
															</span>
														</button>
													</li>
												))}
											</ul>
										) : null}
										{act && actLayer ? (
											<ActStatus
												act={act}
												clock={actLayer.clock}
												nowMs={actLayer.nowMs}
												onAsk={actLayer.onAsk}
												onBlocker={actLayer.onBlocker}
												snapshot={actLayer.snapshot}
											/>
										) : null}
									</li>
								);
							})}
						</ul>
					</section>
				))}
			</div>
		</div>
	);
}
