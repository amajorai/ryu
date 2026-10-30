import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceAgent,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
} from "@ryuhq/protocol/interfaces";
import { useContext } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { type FarmCrop, type FarmPlot, plural } from "./farm-model.ts";
import { CropRow, FarmActMode } from "./farm-panel-rows.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";

/**
 * The seed bag's plot picker: every plot with its agent, what it is for,
 * and how much it has growing, so planting starts by choosing a plot.
 */
function PlotPicker({
	onSelect,
	plots,
}: {
	onSelect: (plotId: string) => void;
	plots: FarmPlot[];
}) {
	const agentPlots = plots.filter((plot) => plot.agent);
	if (agentPlots.length === 0) {
		return null;
	}
	return (
		<section
			aria-labelledby="farm-plots-heading"
			className="flex flex-col gap-1"
		>
			<h3
				className="flex items-baseline gap-2 px-2 font-medium text-foreground text-sm"
				id="farm-plots-heading"
			>
				Plots
				<span className="text-[13px] text-muted-foreground tabular-nums">
					{agentPlots.length}
				</span>
			</h3>
			<ul className="flex flex-col">
				{agentPlots.map((plot) => (
					<li key={plot.id}>
						<button
							className="grid w-full grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
							data-testid="farm-plot-option"
							onClick={() => onSelect(plot.id)}
							type="button"
						>
							{plot.agent ? (
								<BoardAvatar
									agent={plot.agent}
									name={plot.agent.name}
									size={28}
								/>
							) : null}
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="truncate font-medium text-foreground text-sm">
									{plot.name}
								</span>
								<span className="truncate text-[13px] text-muted-foreground">
									{plot.agent?.description || plot.teams[0] || "No description"}
								</span>
							</span>
							<span className="text-right text-[13px] text-muted-foreground tabular-nums">
								{plural(plot.crops.length, "crop")}
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

export function PlotBody({
	activeThreadId,
	agents,
	onOpen,
	onPlant,
	onSelectPlot,
	plot,
	plots,
}: {
	activeThreadId: string | null;
	agents: InterfaceAgent[];
	onOpen: (threadId: string) => void;
	onPlant: (input: { agentId?: string; prompt: string }) => void;
	onSelectPlot: (plotId: string) => void;
	plot: FarmPlot | null;
	plots: FarmPlot[];
}) {
	const tl = useLiteralMessages();
	const agent = plot?.agent ?? undefined;
	const target = agent?.name ?? "an agent";
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="flex flex-col gap-6 p-4">
				<section
					aria-label={plot ? undefined : "Plant a seed"}
					aria-labelledby={plot ? "farm-seed-heading" : undefined}
					className="flex flex-col gap-2"
				>
					{plot ? (
						<div className="flex min-w-0 items-baseline justify-between gap-3">
							<h3
								className="shrink-0 font-medium text-foreground text-sm"
								id="farm-seed-heading"
							>
								Plant a seed
							</h3>
							{agent?.description ? (
								<p className="truncate text-[13px] text-muted-foreground">
									{agent.description}
								</p>
							) : null}
						</div>
					) : null}
					<InterfaceComposer
						agents={agents.length > 0 ? agents : undefined}
						defaultAgentId={agent?.id}
						label={tl("Prompt for {target}", { target })}
						onSubmit={onPlant}
						placeholder={
							agent
								? tl("What should {name} work on?", { name: agent.name })
								: "What should we work on?"
						}
						submitLabel="Plant"
					/>
				</section>
				{plot ? (
					<section
						aria-labelledby="farm-crops-heading"
						className="flex flex-col gap-1"
					>
						<h3
							className="flex items-baseline gap-2 px-2 font-medium text-foreground text-sm"
							id="farm-crops-heading"
						>
							Crops
							<span className="text-[13px] text-muted-foreground tabular-nums">
								{plot.crops.length}
							</span>
						</h3>
						{plot.crops.length === 0 ? (
							<p className="px-2 py-1 text-muted-foreground text-sm">
								Nothing planted yet.
							</p>
						) : (
							<ul className="flex flex-col">
								{plot.crops.map((crop) => (
									<CropRow
										active={crop.thread.id === activeThreadId}
										crop={crop}
										key={crop.thread.id}
										onOpen={onOpen}
									/>
								))}
							</ul>
						)}
					</section>
				) : (
					<PlotPicker onSelect={onSelectPlot} plots={plots} />
				)}
			</div>
		</div>
	);
}

export function BarnBody({
	activeThreadId,
	crops,
	onOpen,
	plotName,
}: {
	activeThreadId: string | null;
	crops: FarmCrop[];
	onOpen: (threadId: string) => void;
	plotName: (crop: FarmCrop) => string;
}) {
	const actMode = useContext(FarmActMode);
	if (crops.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
				<p className="font-medium text-foreground text-sm">The barn is empty</p>
				<p className="max-w-64 text-pretty text-[13px] text-muted-foreground leading-[1.125rem]">
					Every conversation is listed here once it is planted.
				</p>
			</div>
		);
	}
	// With acts the barn groups by plot: the old thread-status headings
	// would contradict the acts the farm shows.
	const sections = actMode
		? [...new Set(crops.map(plotName))].map((name, index) => ({
				crops: crops.filter((crop) => plotName(crop) === name),
				key: `plot-${index}`,
				label: name,
			}))
		: THREAD_STATUS_ORDER.map((status) => ({
				crops: crops.filter((crop) => crop.status === status),
				key: status,
				label: THREAD_STATUS_LABELS[status],
			}));
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="flex flex-col gap-5 p-4">
				{sections.map(({ crops: section, key, label }) => {
					if (section.length === 0) {
						return null;
					}
					const id = `farm-barn-${key}`;
					return (
						<section
							aria-labelledby={id}
							className="flex flex-col gap-1"
							key={key}
						>
							<h3
								className="flex items-baseline gap-2 px-2 font-medium text-foreground text-sm"
								id={id}
							>
								{label}
								<span className="text-[13px] text-muted-foreground tabular-nums">
									{section.length}
								</span>
							</h3>
							<ul className="flex flex-col">
								{section.map((crop) => (
									<CropRow
										active={crop.thread.id === activeThreadId}
										crop={crop}
										key={crop.thread.id}
										onOpen={onOpen}
										plotName={plotName(crop)}
									/>
								))}
							</ul>
						</section>
					);
				})}
			</div>
		</div>
	);
}
