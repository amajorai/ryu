import type { FarmCrop, FarmField, FarmPlot } from "./farm-model.ts";

// ---------------------------------------------------------------------------
// The diorama: the farm laid out in world units on its island
// ---------------------------------------------------------------------------

/**
 * Bed geometry in world units (a villager is about 1.2 tall): the slot
 * pitch, the timber frame's padding, room to the right of the bed for its
 * farmer, and room in front for its plate.
 */
export const BED = {
	farmer: 0.95,
	front: 0.45,
	pad: 0.32,
	pitch: 0.92,
} as const;

/** Gaps between plots, around a fenced field's plots, and between rows. */
const PLOT_GAP = 0.55;
const FIELD_PAD = 0.55;
const ROW_GAP = 1.5;
const BLOCK_GAP = 1.1;
/** The barn yard: the barn, its silo and hay, and the pond beside it. */
const YARD = { depth: 4.6, width: 6.6 } as const;

export interface Rect {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
}

/** One crop in its bed slot, where it grows. */
export interface PlacedCrop {
	crop: FarmCrop;
	x: number;
	z: number;
}

export interface PlacedBed {
	/** The bed's timber frame. */
	bed: Rect;
	crops: PlacedCrop[];
	/** Where the plot's farmer stands. */
	farmer: [number, number];
	plot: FarmPlot;
	/** Where its plate or sign stands, in front of the bed. */
	sign: [number, number];
}

export interface PlacedField {
	/** Its fence line (fenced fields only). */
	fence: Rect | null;
	field: FarmField;
	/** Where the field's name board stands. */
	sign: [number, number];
}

export interface FarmDiorama {
	/** The barn's footprint (its door faces the camera, +z). */
	barn: Rect;
	beds: PlacedBed[];
	/** Everything the camera fits. */
	bounds: Rect;
	fields: PlacedField[];
	/** Paths of packed earth between the rows of fields. */
	paths: Rect[];
	pond: { radius: number; x: number; z: number };
	silo: [number, number];
}

function bedSize(plot: Pick<FarmPlot, "columns" | "rows">) {
	return {
		depth: plot.rows * BED.pitch + BED.pad * 2,
		width: plot.columns * BED.pitch + BED.pad * 2,
	};
}

/** A plot's footprint: the bed, its farmer and the plate in front. */
export function plotFootprint(plot: Pick<FarmPlot, "columns" | "rows">) {
	const { depth, width } = bedSize(plot);
	return { depth: depth + BED.front, width: width + BED.farmer };
}

/** Places a plot with its footprint's top left at (x, z). */
function placeBed(plot: FarmPlot, x: number, z: number): PlacedBed {
	const { depth, width } = bedSize(plot);
	const bed = { maxX: x + width, maxZ: z + depth, minX: x, minZ: z };
	const crops = plot.planted.map(({ crop, slot }) => {
		const column = slot % plot.columns;
		const row = Math.floor(slot / plot.columns);
		return {
			crop,
			x: x + BED.pad + BED.pitch * (column + 0.5),
			z: z + BED.pad + BED.pitch * (row + 0.5),
		};
	});
	return {
		bed,
		crops,
		farmer: [bed.maxX + BED.farmer * 0.5, z + depth * 0.62],
		plot,
		sign: [x + width / 2, bed.maxZ + 0.28],
	};
}

interface Block {
	depth: number;
	/** Places the block with its top left at (x, z). */
	place: (x: number, z: number) => void;
	width: number;
}

/** A field's plots in a grid: up to three across. */
function fieldBlock(field: FarmField, out: FarmDiorama): Block {
	const columns = Math.min(
		3,
		Math.max(1, field.plots.length === 4 ? 2 : field.plots.length)
	);
	const sizes = field.plots.map(plotFootprint);
	const columnWidths: number[] = [];
	const rowDepths: number[] = [];
	for (const [index, size] of sizes.entries()) {
		const column = index % columns;
		const row = Math.floor(index / columns);
		columnWidths[column] = Math.max(columnWidths[column] ?? 0, size.width);
		rowDepths[row] = Math.max(rowDepths[row] ?? 0, size.depth);
	}
	const sum = (values: number[]) =>
		values.reduce((total, value) => total + value, 0);
	const pad = field.fenced ? FIELD_PAD : 0;
	const width =
		sum(columnWidths) + PLOT_GAP * (columnWidths.length - 1) + pad * 2;
	const depth = sum(rowDepths) + PLOT_GAP * (rowDepths.length - 1) + pad * 2;
	return {
		depth,
		place: (x, z) => {
			let top = z + pad;
			for (let row = 0; row < rowDepths.length; row++) {
				let left = x + pad;
				for (let column = 0; column < columns; column++) {
					const plot = field.plots[row * columns + column];
					if (plot) {
						out.beds.push(placeBed(plot, left, top));
					}
					left += (columnWidths[column] ?? 0) + PLOT_GAP;
				}
				top += (rowDepths[row] ?? 0) + PLOT_GAP;
			}
			out.fields.push({
				fence: field.fenced
					? { maxX: x + width, maxZ: z + depth, minX: x, minZ: z }
					: null,
				field,
				sign: [x + 0.2, z + 0.2],
			});
		},
		width,
	};
}

/**
 * Lays the farm out as a diorama: the barn yard (barn, silo, hay and the
 * pond) and every field as blocks packed into rows about as wide as the
 * farm is deep, with earthen paths between the rows, centered on the
 * origin.
 */
export function layoutDiorama(fields: readonly FarmField[]): FarmDiorama {
	const out: FarmDiorama = {
		barn: { maxX: 0, maxZ: 0, minX: 0, minZ: 0 },
		beds: [],
		bounds: { maxX: 0, maxZ: 0, minX: 0, minZ: 0 },
		fields: [],
		paths: [],
		pond: { radius: 1, x: 0, z: 0 },
		silo: [0, 0],
	};
	const blocks: Block[] = [
		{
			depth: YARD.depth,
			place: (x, z) => {
				out.barn = { maxX: x + 3.4, maxZ: z + 2.8, minX: x, minZ: z };
				out.silo = [x + 4.3, z + 0.9];
				out.pond = { radius: 0.95, x: x + 5.3, z: z + 3.3 };
			},
			width: YARD.width,
		},
		...fields
			.filter((field) => field.plots.length > 0)
			.map((field) => fieldBlock(field, out)),
	];
	const area = blocks.reduce(
		(total, block) =>
			total + (block.width + BLOCK_GAP) * (block.depth + ROW_GAP),
		0
	);
	const widest = Math.max(...blocks.map((block) => block.width));
	const rowWidth = Math.max(widest, Math.sqrt(area) * 1.35);
	const rows: Block[][] = [];
	let current: Block[] = [];
	let used = 0;
	for (const block of blocks) {
		const next = used === 0 ? block.width : used + BLOCK_GAP + block.width;
		if (current.length > 0 && next > rowWidth) {
			rows.push(current);
			current = [];
			used = 0;
		}
		current.push(block);
		used = used === 0 ? block.width : used + BLOCK_GAP + block.width;
	}
	if (current.length > 0) {
		rows.push(current);
	}
	const widths = rows.map((row) =>
		row.reduce(
			(total, block, index) => total + block.width + (index ? BLOCK_GAP : 0),
			0
		)
	);
	const fullWidth = Math.max(...widths);
	let z = 0;
	for (const [index, row] of rows.entries()) {
		const depth = Math.max(...row.map((block) => block.depth));
		// Rows are centered; blocks sit on the row's front line.
		let x = (fullWidth - (widths[index] ?? 0)) / 2;
		for (const block of row) {
			block.place(x, z + depth - block.depth);
			x += block.width + BLOCK_GAP;
		}
		z += depth;
		if (index < rows.length - 1) {
			out.paths.push({
				maxX: fullWidth + 0.6,
				maxZ: z + ROW_GAP * 0.72,
				minX: -0.6,
				minZ: z + ROW_GAP * 0.28,
			});
			z += ROW_GAP;
		}
	}
	// Center the farm on the origin.
	const dx = -fullWidth / 2;
	const dz = -z / 2;
	const shift = (rect: Rect): Rect => ({
		maxX: rect.maxX + dx,
		maxZ: rect.maxZ + dz,
		minX: rect.minX + dx,
		minZ: rect.minZ + dz,
	});
	out.barn = shift(out.barn);
	out.silo = [out.silo[0] + dx, out.silo[1] + dz];
	out.pond = { ...out.pond, x: out.pond.x + dx, z: out.pond.z + dz };
	out.paths = out.paths.map(shift);
	out.beds = out.beds.map((placed) => ({
		...placed,
		bed: shift(placed.bed),
		crops: placed.crops.map((crop) => ({
			...crop,
			x: crop.x + dx,
			z: crop.z + dz,
		})),
		farmer: [placed.farmer[0] + dx, placed.farmer[1] + dz],
		sign: [placed.sign[0] + dx, placed.sign[1] + dz],
	}));
	out.fields = out.fields.map((placed) => ({
		...placed,
		fence: placed.fence ? shift(placed.fence) : null,
		sign: [placed.sign[0] + dx, placed.sign[1] + dz],
	}));
	out.bounds = {
		maxX: fullWidth / 2,
		maxZ: z / 2 + 0.6,
		minX: -fullWidth / 2,
		minZ: -z / 2,
	};
	return out;
}

/** Whether (x, z) lies inside `rect` grown by `margin`. */
export function inRect(rect: Rect, x: number, z: number, margin = 0): boolean {
	return (
		x > rect.minX - margin &&
		x < rect.maxX + margin &&
		z > rect.minZ - margin &&
		z < rect.maxZ + margin
	);
}
