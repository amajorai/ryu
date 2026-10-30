import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * The Farm's view model: agents become plots, projects become fenced fields
 * that group their agents' plots, and every conversation is a crop whose
 * growth stage is its status. Pure, so the layout and labels are testable.
 */

export const FRUITS = [
	"strawberry",
	"tomato",
	"apple",
	"pumpkin",
	"grapes",
	"blueberry",
] as const;
export type FruitKind = (typeof FRUITS)[number];

export const FRUIT_NAMES: Record<FruitKind, string> = {
	apple: "Apple tree",
	blueberry: "Blueberries",
	grapes: "Grapes",
	pumpkin: "Pumpkin",
	strawberry: "Strawberries",
	tomato: "Tomatoes",
};

/** Seed: you wrote. Growing: a run is live. Ripe: your turn. */
export type CropStage = "fallow" | "growing" | "ripe" | "seed" | "withered";

const STAGE_BY_STATUS: Record<ThreadStatus, CropStage> = {
	attention: "withered",
	quiet: "fallow",
	waiting: "seed",
	working: "growing",
	"your-turn": "ripe",
};

export const STAGE_NAMES: Record<CropStage, string> = {
	fallow: "Fallow",
	growing: "Growing",
	ripe: "Ripe",
	seed: "Seeded",
	withered: "Withered",
};

/** What the stage asks of the user, in the farm's own words. */
export const STAGE_HINTS: Record<CropStage, string> = {
	fallow: "Nothing said yet",
	growing: "Agent is working",
	ripe: "Ready to harvest",
	seed: "Watered, waiting on the agent",
	withered: "The run failed",
};

export interface FarmCrop {
	agentId: string | null;
	fruit: FruitKind;
	/**
	 * Real progress of a growing crop (its plan's done / total, 0..1), from
	 * the act layer: the plant grows to it. Absent: the usual growing size.
	 */
	growth?: number;
	/**
	 * A ripe reply waiting to be read over-ripens by its wait band: this
	 * many fruits have fallen to the soil (0 to 3), from the act layer.
	 */
	overripe?: number;
	stage: CropStage;
	status: ThreadStatus;
	thread: InterfaceThread;
}

/** A crop in its bed slot (row-major: slot = row * columns + column). */
export interface PlantedCrop {
	crop: FarmCrop;
	slot: number;
}

export interface FarmPlot {
	agent: InterfaceAgent | null;
	/** Planting slots across the bed. */
	columns: number;
	/** Every crop on the plot, most urgent first. */
	crops: FarmCrop[];
	/** Crops that do not fit the bed (the barn lists them). */
	hidden: number;
	id: string;
	name: string;
	/** The crops in the bed with their slots, back furrow first (draw order). */
	planted: PlantedCrop[];
	/** Furrows in the bed (one for a small plot, two for a busy one). */
	rows: number;
	/** The crops planted in the bed's slots, most urgent first. */
	shown: FarmCrop[];
	/** Teams the plot's agent belongs to. */
	teams: string[];
	working: boolean;
}

/**
 * How a plot's bed looks: its most urgent crop decides (a failed run dries
 * the bed out before a ripe crop enriches it), so beds read apart at a
 * glance instead of all being the same brown.
 */
export type PlotMood = CropStage;

const MOOD_ORDER: readonly CropStage[] = [
	"withered",
	"ripe",
	"growing",
	"seed",
	"fallow",
];

export function plotMood(plot: Pick<FarmPlot, "crops">): PlotMood {
	for (const stage of MOOD_ORDER) {
		if (plot.crops.some((crop) => crop.stage === stage)) {
			return stage;
		}
	}
	return "fallow";
}

export interface FarmField {
	/** Projects are fenced; agents in no project farm open plots. */
	fenced: boolean;
	id: string;
	name: string;
	plots: FarmPlot[];
}

export interface FarmTotals {
	coins: number;
	crops: number;
	fallow: number;
	growing: number;
	ripe: number;
	seeds: number;
	withered: number;
}

export interface FarmModel {
	crops: FarmCrop[];
	fields: FarmField[];
	plots: FarmPlot[];
	totals: FarmTotals;
}

export const SHARED_PLOT_ID = "plot-shared";
export const OPEN_FIELD_ID = "field-open";

/** The largest bed: three slots across, two furrows deep. */
export const BED_COLUMNS = 3;
export const BED_ROWS = 2;
export const BED_SLOTS = BED_COLUMNS * BED_ROWS;

/**
 * How tall each plant stands when ripe, in plant units. The range is kept
 * within 1.6x so a dwarf apple tree never towers over a strawberry bed.
 */
export const PLANT_HEIGHT: Record<FruitKind, number> = {
	apple: 54,
	blueberry: 38,
	grapes: 50,
	pumpkin: 34,
	strawberry: 34,
	tomato: 48,
};

/** A growing plant is drawn at this share of its ripe height. */
export const GROWING_SCALE = 0.78;

/** A growing crop's share of its ripe height at `growth` (0..1) of its plan. */
export function growingScale(growth: number): number {
	const clamped = Math.max(0, Math.min(1, growth));
	return 0.45 + clamped * (GROWING_SCALE + 0.12 - 0.45);
}

/** How tall a crop stands at its stage, in plant units. */
export function cropHeight(
	crop: Pick<FarmCrop, "fruit" | "growth" | "stage">
): number {
	if (crop.stage === "seed" || crop.stage === "fallow") {
		return 14;
	}
	const height = PLANT_HEIGHT[crop.fruit];
	if (crop.stage !== "growing") {
		return height;
	}
	return crop.growth === undefined
		? height * GROWING_SCALE
		: height * growingScale(crop.growth);
}

/**
 * The bed a plot of `count` crops gets: sized to its crops (two slots at
 * least), so a bed always reads as planted, not bare.
 */
export function bedShape(count: number): { columns: number; rows: number } {
	if (count <= 2) {
		return { columns: 2, rows: 1 };
	}
	return { columns: BED_COLUMNS, rows: BED_ROWS };
}

/**
 * Which slots a two-furrow bed of `count` crops plants, spread over both
 * furrows so a bed never reads as one corner planted and the rest bare.
 */
const SLOT_PATTERNS: readonly (readonly number[])[] = [
	[],
	[4],
	[0, 5],
	[0, 2, 4],
	[0, 2, 3, 5],
	[0, 1, 2, 3, 5],
	[0, 1, 2, 3, 4, 5],
];

/** Where the next seed goes in a two-furrow bed: front furrow, center out. */
const SEED_ORDER = [4, 3, 5, 1, 0, 2] as const;

/**
 * Plants a bed. One furrow fills left to right (the spare slot is by the
 * farmer); two furrows put the tallest crops at the back.
 */
export function plantBed(
	shown: FarmCrop[],
	shape: { columns: number; rows: number } = bedShape(shown.length)
): PlantedCrop[] {
	const byHeight = [...shown].sort((a, b) => cropHeight(b) - cropHeight(a));
	const slots =
		shape.rows === 1
			? byHeight.map((_, index) => index)
			: [...(SLOT_PATTERNS[shown.length] ?? SLOT_PATTERNS[BED_SLOTS] ?? [])];
	const planted: PlantedCrop[] = [];
	for (const [index, crop] of byHeight.entries()) {
		const slot = slots[index];
		if (slot !== undefined) {
			planted.push({ crop, slot });
		}
	}
	// Back furrow first, then left to right: the order the bed is painted in.
	return planted.sort((a, b) => a.slot - b.slot);
}

/** The free slot a new seed would go in, or null when the bed is full. */
export function seedSlot(
	plot: Pick<FarmPlot, "columns" | "planted" | "rows">
): number | null {
	const taken = new Set(plot.planted.map((item) => item.slot));
	const order: readonly number[] =
		plot.rows === 1
			? Array.from({ length: plot.columns }, (_, index) => index)
			: SEED_ORDER;
	return order.find((slot) => !taken.has(slot)) ?? null;
}

export function hashId(id: string): number {
	let hash = 2_166_136_261;
	for (const char of id) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** A stable fruit for a conversation: the same thread always grows the same. */
export function fruitFor(threadId: string): FruitKind {
	return FRUITS[hashId(threadId) % FRUITS.length] ?? "strawberry";
}

export function stageFor(status: ThreadStatus): CropStage {
	return STAGE_BY_STATUS[status];
}

function updatedAt(thread: InterfaceThread): number {
	const time = Date.parse(thread.updatedAt);
	return Number.isNaN(time) ? 0 : time;
}

/** Most urgent first (failed, your turn, working, waiting, quiet), then newest. */
export function compareCrops(a: FarmCrop, b: FarmCrop): number {
	return (
		THREAD_STATUS_ORDER.indexOf(a.status) -
			THREAD_STATUS_ORDER.indexOf(b.status) ||
		updatedAt(b.thread) - updatedAt(a.thread)
	);
}

export function makePlot(
	id: string,
	agent: InterfaceAgent | null,
	crops: FarmCrop[],
	teams: string[] = []
): FarmPlot {
	const sorted = [...crops].sort(compareCrops);
	const shown = sorted.slice(0, BED_SLOTS);
	const shape = bedShape(shown.length);
	return {
		agent,
		columns: shape.columns,
		crops: sorted,
		hidden: Math.max(0, sorted.length - BED_SLOTS),
		id,
		name: agent?.name ?? "Shared bed",
		planted: plantBed(shown, shape),
		rows: shape.rows,
		shown,
		teams,
		working:
			agent?.status === "working" ||
			sorted.some((crop) => crop.stage === "growing"),
	};
}

export function buildFarm(snapshot: InterfaceSnapshot): FarmModel {
	const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
	const cropsByPlot = new Map<string, FarmCrop[]>();
	const crops: FarmCrop[] = [];
	for (const thread of snapshot.threads) {
		const agentId = thread.agentIds.find((id) => agentIds.has(id)) ?? null;
		const status = threadStatus(thread);
		const crop: FarmCrop = {
			agentId,
			fruit: fruitFor(thread.id),
			stage: stageFor(status),
			status,
			thread,
		};
		crops.push(crop);
		const key = agentId ?? SHARED_PLOT_ID;
		const list = cropsByPlot.get(key) ?? [];
		list.push(crop);
		cropsByPlot.set(key, list);
	}
	crops.sort(compareCrops);
	const teamsOf = (agentId: string) =>
		snapshot.groups
			.filter(
				(group) =>
					group.kind === "team" && group.memberAgentIds.includes(agentId)
			)
			.map((group) => group.name);
	const plotFor = (agent: InterfaceAgent) =>
		makePlot(
			agent.id,
			agent,
			cropsByPlot.get(agent.id) ?? [],
			teamsOf(agent.id)
		);

	const placed = new Set<string>();
	const fields: FarmField[] = [];
	for (const group of snapshot.groups) {
		if (group.kind !== "project") {
			continue;
		}
		const plots: FarmPlot[] = [];
		for (const agent of snapshot.agents) {
			if (placed.has(agent.id) || !group.memberAgentIds.includes(agent.id)) {
				continue;
			}
			placed.add(agent.id);
			plots.push(plotFor(agent));
		}
		if (plots.length > 0) {
			fields.push({ fenced: true, id: group.id, name: group.name, plots });
		}
	}
	const open: FarmPlot[] = [];
	for (const agent of snapshot.agents) {
		if (!placed.has(agent.id)) {
			open.push(plotFor(agent));
		}
	}
	const shared = cropsByPlot.get(SHARED_PLOT_ID);
	if (shared && shared.length > 0) {
		open.push(makePlot(SHARED_PLOT_ID, null, shared));
	}
	if (open.length > 0) {
		fields.push({
			fenced: false,
			id: OPEN_FIELD_ID,
			name: "Open plots",
			plots: open,
		});
	}

	const totals: FarmTotals = {
		coins: 0,
		crops: crops.length,
		fallow: 0,
		growing: 0,
		ripe: 0,
		seeds: 0,
		withered: 0,
	};
	for (const crop of crops) {
		totals.coins += Math.max(0, crop.thread.messageCount);
		if (crop.stage === "ripe") {
			totals.ripe += 1;
		} else if (crop.stage === "growing") {
			totals.growing += 1;
		} else if (crop.stage === "seed") {
			totals.seeds += 1;
		} else if (crop.stage === "withered") {
			totals.withered += 1;
		} else {
			totals.fallow += 1;
		}
	}
	return {
		crops,
		fields,
		plots: fields.flatMap((field) => field.plots),
		totals,
	};
}

export function plotForThread(
	model: FarmModel,
	threadId: string | null
): FarmPlot | undefined {
	if (!threadId) {
		return undefined;
	}
	return model.plots.find((plot) =>
		plot.crops.some((crop) => crop.thread.id === threadId)
	);
}

export function cropTitle(thread: InterfaceThread | undefined): string {
	return thread?.title.trim() || "Untitled conversation";
}

/** The accessible name of a plant: what it is, whose it is, where it stands. */
export function cropLabel(crop: FarmCrop, plotName: string): string {
	const action = crop.stage === "ripe" ? "Harvest" : "Inspect";
	return `${action} ${cropTitle(crop.thread)}: ${FRUIT_NAMES[crop.fruit]} in ${plotName}'s plot, ${STAGE_NAMES[crop.stage].toLowerCase()}`;
}

export function plural(count: number, noun: string, many = `${noun}s`) {
	return `${count} ${count === 1 ? noun : many}`;
}

/** Days the farm has been running: the oldest conversation is day one. */
export function farmDay(threads: InterfaceThread[], now: number): number {
	let oldest = now;
	for (const thread of threads) {
		const time = updatedAt(thread);
		if (time > 0 && time < oldest) {
			oldest = time;
		}
	}
	const start = new Date(oldest);
	start.setHours(0, 0, 0, 0);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	return Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1;
}

export type {
	FarmDiorama,
	PlacedBed,
	PlacedCrop,
	PlacedField,
	Rect,
} from "./farm-model-diorama.ts";
export {
	BED,
	inRect,
	layoutDiorama,
	plotFootprint,
} from "./farm-model-diorama.ts";

/** A plot's accessible name: whose it is, its team, and how much grows. */
export function plotLabel(plot: Pick<FarmPlot, "crops" | "name" | "teams">) {
	const team = plot.teams[0];
	return `${plot.name}'s plot${team ? `, ${team}` : ""}: ${plural(plot.crops.length, "crop")}`;
}
