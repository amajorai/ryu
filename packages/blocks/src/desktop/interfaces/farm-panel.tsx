import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
} from "@ryuhq/protocol/interfaces";
import { Warehouse } from "lucide-react";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	type Ref,
	useContext,
} from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import {
	cropTitle,
	type FarmCrop,
	type FarmPlot,
	FRUIT_NAMES,
	plural,
} from "./farm-model.ts";
import { PlantGlyph } from "./farm-plants.tsx";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { compactAge } from "./interface-renderer.ts";

export type FarmPanelView =
	| { crop: FarmCrop | undefined; kind: "thread"; plot: FarmPlot | undefined }
	| { kind: "plot"; plot: FarmPlot | null }
	| { kind: "barn" };

/**
 * A crop in a list. In the barn its section already names the status, so
 * the row names the crop and its plot; in a plot it names the status.
 */
function CropRow({
	active,
	crop,
	onOpen,
	plotName,
}: {
	active: boolean;
	crop: FarmCrop;
	onOpen: (threadId: string) => void;
	plotName?: string;
}) {
	// With acts a crop row carries no legacy status or last-update age.
	const actMode = useContext(FarmActMode);
	let detail = `${THREAD_STATUS_LABELS[crop.status]} · ${FRUIT_NAMES[crop.fruit]}`;
	if (plotName) {
		detail = `${FRUIT_NAMES[crop.fruit]} · ${plotName}`;
	} else if (actMode) {
		detail = FRUIT_NAMES[crop.fruit];
	}
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					"grid w-full grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
					active && "bg-muted"
				)}
				data-testid="farm-row"
				onClick={() => onOpen(crop.thread.id)}
				type="button"
			>
				<PlantGlyph className="size-8" fruit={crop.fruit} stage={crop.stage} />
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground text-sm">
						{cropTitle(crop.thread)}
					</span>
					<span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
						{actMode ? null : <BoardStatusDot status={crop.status} />}
						<span className="truncate">{detail}</span>
					</span>
				</span>
				<span className="self-start pt-0.5 text-right text-[13px] text-muted-foreground tabular-nums">
					{actMode ? null : compactAge(crop.thread.updatedAt)}
				</span>
			</button>
		</li>
	);
}

/** Whether the act layer is on (the panel's rows then follow it). */
const FarmActMode = createContext(false);

/** The stall's striped awning edge along the top of the ledger. */
const AWNING: CSSProperties = {
	backgroundImage:
		"repeating-linear-gradient(90deg, var(--border) 0 12px, transparent 12px 24px)",
};

/**
 * The market-stall ledger under an open conversation's title: one ruled
 * entry for the crop (whose plot, which crop, where it stands) with what it
 * has earned in a right-aligned coins column.
 */
function Ledger({
	crop,
	plot,
}: {
	crop: FarmCrop;
	plot: FarmPlot | undefined;
}) {
	const label = "text-[13px] text-muted-foreground";
	// With acts the ledger drops the thread's legacy status.
	const actMode = useContext(FarmActMode);
	return (
		<div className="shrink-0 border-border border-b" data-testid="farm-ledger">
			<div
				aria-hidden="true"
				className="h-2 border-border border-b"
				style={AWNING}
			/>
			<dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] text-sm">
				<div className="flex min-w-0 flex-col gap-1 py-2.5 pl-4">
					<dt className={label}>Plot</dt>
					<dd className="truncate font-medium text-foreground">
						{plot?.name ?? "Shared bed"}
					</dd>
				</div>
				<div className="flex min-w-0 flex-col gap-1 py-2.5 pl-3">
					<dt className={label}>Crop</dt>
					<dd className="truncate text-foreground">
						{FRUIT_NAMES[crop.fruit]}
					</dd>
				</div>
				{actMode ? null : (
					<div className="flex min-w-0 flex-col gap-1 py-2.5 pl-3">
						<dt className={label}>Status</dt>
						<dd className="flex min-w-0 items-center gap-1.5 text-foreground">
							<BoardStatusDot status={crop.status} />
							<span className="truncate">
								{THREAD_STATUS_LABELS[crop.status]}
							</span>
						</dd>
					</div>
				)}
				<div className="flex min-w-16 flex-col items-end gap-1 border-border border-l py-2.5 pr-4 pl-3">
					<dt className={label}>Coins</dt>
					<dd
						className="font-medium text-foreground tabular-nums"
						data-testid="farm-ledger-coins"
					>
						{crop.thread.messageCount}
					</dd>
				</div>
			</dl>
		</div>
	);
}

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

function PlotBody({
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
						label={`Prompt for ${target}`}
						onSubmit={onPlant}
						placeholder={
							agent
								? `What should ${agent.name} work on?`
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

function BarnBody({
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

/**
 * The side panel: an open conversation under its ledger line (the host's
 * own thread view), a plot with its seed bag and crops, or the barn's list
 * of every crop.
 */
export function FarmPanel(
	props: Parameters<typeof FarmPanelBody>[0] & {
		/** With acts, crop rows drop the legacy status and ages. */
		actMode?: boolean;
	}
) {
	const { actMode = false, ...rest } = props;
	return (
		<FarmActMode.Provider value={actMode}>
			<FarmPanelBody {...rest} />
		</FarmActMode.Provider>
	);
}

function FarmPanelBody({
	activeThreadId,
	agents,
	crops,
	headingRef,
	onClose,
	onOpen,
	onPlant,
	onSelectPlot,
	plotName,
	plots,
	threadView,
	view,
}: {
	activeThreadId: string | null;
	agents: InterfaceAgent[];
	crops: FarmCrop[];
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	onOpen: (threadId: string) => void;
	onPlant: (input: { agentId?: string; prompt: string }) => void;
	onSelectPlot: (plotId: string) => void;
	plotName: (crop: FarmCrop) => string;
	plots: FarmPlot[];
	threadView: ReactNode;
	view: FarmPanelView;
}) {
	let label = "Barn";
	if (view.kind === "thread") {
		label = `Conversation: ${cropTitle(view.crop?.thread)}`;
	} else if (view.kind === "plot") {
		label = view.plot ? `${view.plot.name}'s plot` : "Plant a seed";
	}
	if (view.kind === "thread") {
		return (
			<GameSheet
				closeLabel="Close conversation"
				data-testid="farm-panel"
				data-view="thread"
				headingRef={headingRef}
				label={label}
				leading={
					view.crop ? (
						<span className="grid size-11 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
							<PlantGlyph
								className="size-8"
								fruit={view.crop.fruit}
								stage={view.crop.stage}
							/>
						</span>
					) : undefined
				}
				onClose={onClose}
				sheetKey={`thread:${view.crop?.thread.id ?? ""}`}
				subtitle={view.plot ? `${view.plot.name}'s plot` : undefined}
				title={view.crop ? cropTitle(view.crop.thread) : "New conversation"}
			>
				{view.crop ? <Ledger crop={view.crop} plot={view.plot} /> : null}
				<div className="flex min-h-0 flex-1 flex-col">{threadView}</div>
			</GameSheet>
		);
	}
	if (view.kind === "plot") {
		return (
			<GameSheet
				closeLabel="Close plot"
				data-testid="farm-panel"
				data-view="plot"
				headingRef={headingRef}
				label={label}
				leading={
					view.plot?.agent ? (
						<span className="grid size-10 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-plate-sunk)">
							<BoardAvatar
								agent={view.plot.agent}
								name={view.plot.agent.name}
								size={28}
							/>
						</span>
					) : undefined
				}
				onClose={onClose}
				sheetKey="plot"
				subtitle={
					view.plot
						? `${plural(view.plot.crops.length, "crop")}${view.plot.agent?.status === "working" ? " · Working" : ""}`
						: "Pick a plot, then describe the task"
				}
				title={view.plot ? `${view.plot.name}'s plot` : "Plant a seed"}
			>
				<PlotBody
					activeThreadId={activeThreadId}
					agents={agents}
					onOpen={onOpen}
					onPlant={onPlant}
					onSelectPlot={onSelectPlot}
					plot={view.plot}
					plots={plots}
				/>
			</GameSheet>
		);
	}
	return (
		<GameSheet
			closeLabel="Close barn"
			data-testid="farm-panel"
			data-view="barn"
			headingRef={headingRef}
			label={label}
			leading={
				<span className="grid size-10 place-items-center rounded-xl border-(--gk-edge) border-2 bg-(--gk-accent) text-(--gk-accent-ink)">
					<Warehouse aria-hidden="true" className="size-5" strokeWidth={2.25} />
				</span>
			}
			onClose={onClose}
			sheetKey="barn"
			subtitle={`${plural(crops.length, "crop")} by status`}
			title="Barn"
		>
			<BarnBody
				activeThreadId={activeThreadId}
				crops={crops}
				onOpen={onOpen}
				plotName={plotName}
			/>
		</GameSheet>
	);
}
