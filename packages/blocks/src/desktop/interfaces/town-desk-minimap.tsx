import { cn } from "@ryu/ui/lib/utils";
import { ROAD, roadLines, SIDEWALK, type Town } from "./town-model.ts";
import {
	districtColor,
	mixHex,
	type TownDataView,
	type TownPalette,
} from "./town-palette.ts";

/**
 * The swatch a district shows in the legend: its ground tint by day; at
 * night the tint is lifted toward the facades so it reads on a dark card.
 */
export function districtSwatch(
	palette: TownPalette,
	dataView: TownDataView,
	district: { activity: number; needs: number; tint: number }
): string {
	const ground = districtColor(palette, dataView, district);
	return palette.mode === "dark" && dataView === "none"
		? mixHex(ground, palette.column, 0.35)
		: ground;
}

/** The minimap's squash: the 45° turn flattened like the isometric view. */
const MAP_SQUASH = 0.62;

/**
 * Where a point of the town lands on the minimap, as fractions of its box:
 * the same turn and squash as the SVG, so HTML labels sit on the blocks.
 */
export function minimapPoint(
	x: number,
	z: number,
	view: number
): { left: number; top: number } {
	const turnedX = (x - z) * Math.SQRT1_2;
	const turnedY = (x + z) * Math.SQRT1_2 * MAP_SQUASH;
	return {
		left: (turnedX + view) / (view * 2),
		top: (turnedY + view * MAP_SQUASH) / (view * 2 * MAP_SQUASH),
	};
}

function mapView(town: Town): { half: number; view: number } {
	const half = town.grid.reach + ROAD / 2 + 0.6;
	return { half, view: half * Math.SQRT2 };
}

/**
 * The minimap: the town from above, turned 45° so it reads the same way as
 * the isometric camera. Roads are drawn, buildings are dots and status
 * shows as theme colour; the block under the pointer (or the district row
 * in focus) is outlined and named.
 */
export function Minimap({
	dataView,
	highlightId,
	onDistrict,
	onHall,
	onHighlight,
	palette,
	selectedId,
	town,
}: {
	dataView: TownDataView;
	highlightId: string | null;
	onDistrict: (districtId: string) => void;
	onHall: () => void;
	onHighlight: (id: string | null) => void;
	palette: TownPalette;
	selectedId: string | null;
	town: Town;
}) {
	const { inner, reach } = town.grid;
	const block = inner + SIDEWALK * 2;
	const { half, view } = mapView(town);
	const lines = roadLines(town.grid);
	const span = reach + ROAD / 2;
	const highlighted =
		highlightId === "hall"
			? { name: "City Hall", x: 0, z: 0 }
			: town.districts.find((item) => item.id === highlightId);
	const label = highlighted
		? minimapPoint(highlighted.x, highlighted.z, view)
		: null;
	return (
		<>
			<svg
				aria-hidden="true"
				className="absolute inset-0 size-full"
				focusable="false"
				onPointerLeave={() => onHighlight(null)}
				viewBox={`${-view} ${-view * MAP_SQUASH} ${view * 2} ${view * 2 * MAP_SQUASH}`}
			>
				<g transform={`scale(1 ${MAP_SQUASH}) rotate(45)`}>
					<rect
						className="fill-muted"
						height={half * 2}
						rx={0.8}
						width={half * 2}
						x={-half}
						y={-half}
					/>
					{lines.map((line) => (
						<g className="stroke-muted-foreground/30" key={`road-${line}`}>
							<line
								strokeWidth={ROAD * 0.7}
								x1={-span}
								x2={span}
								y1={line}
								y2={line}
							/>
							<line
								strokeWidth={ROAD * 0.7}
								x1={line}
								x2={line}
								y1={-span}
								y2={span}
							/>
						</g>
					))}
					{town.parks.map((park) => (
						<rect
							fill={palette.grassDark}
							height={block}
							key={park.id}
							rx={0.4}
							width={block}
							x={park.x - block / 2}
							y={park.z - block / 2}
						/>
					))}
					<rect
						className={cn(
							"cursor-pointer fill-card",
							highlightId === "hall" ? "stroke-foreground" : "stroke-border"
						)}
						height={block}
						onClick={onHall}
						onPointerEnter={() => onHighlight("hall")}
						rx={0.4}
						strokeWidth={highlightId === "hall" ? 0.3 : 0.12}
						width={block}
						x={-block / 2}
						y={-block / 2}
					/>
					<rect
						className="pointer-events-none fill-muted-foreground/60"
						height={2.2}
						width={3.4}
						x={-1.7}
						y={-1.6}
					/>
					{town.districts.map((district) => (
						<rect
							className={cn(
								"cursor-pointer",
								highlightId === district.id && "stroke-foreground"
							)}
							fill={districtColor(palette, dataView, district)}
							height={block}
							key={district.id}
							onClick={() => onDistrict(district.id)}
							onPointerEnter={() => onHighlight(district.id)}
							rx={0.4}
							strokeWidth={highlightId === district.id ? 0.3 : 0}
							width={block}
							x={district.x - block / 2}
							y={district.z - block / 2}
						/>
					))}
					<g className="pointer-events-none">
						{[
							...town.districts.flatMap((district) => district.fillers),
							...town.parks.flatMap((park) => park.homes),
						].map((filler) => (
							<rect
								className="fill-foreground/25"
								height={1}
								key={filler.id}
								rx={0.15}
								width={1}
								x={filler.lot.x - 0.5}
								y={filler.lot.z - 0.5}
							/>
						))}
						{town.buildings.map((building) => {
							let tone = "fill-foreground/60";
							if (building.alert) {
								tone = "fill-destructive";
							} else if (building.replied) {
								tone = "fill-primary";
							} else if (building.working) {
								tone = "fill-success";
							}
							const selected = building.agent.id === selectedId;
							return (
								<rect
									className={cn(tone, selected && "stroke-foreground")}
									height={1.3}
									key={building.agent.id}
									rx={0.2}
									strokeWidth={selected ? 0.3 : 0}
									width={1.3}
									x={building.lot.x - 0.65}
									y={building.lot.z - 0.65}
								/>
							);
						})}
					</g>
				</g>
			</svg>
			{highlighted && label ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute flex h-5 -translate-x-1/2 -translate-y-1/2 items-center whitespace-nowrap rounded bg-background px-1.5 font-medium text-(--gk-ink) text-[13px] shadow-xs ring-1 ring-border"
					style={{ left: `${label.left * 100}%`, top: `${label.top * 100}%` }}
				>
					{highlighted.name}
				</span>
			) : null}
		</>
	);
}
