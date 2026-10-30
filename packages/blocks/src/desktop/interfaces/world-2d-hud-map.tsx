import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { WorldLayout, WorldPoint } from "@ryuhq/protocol/interfaces";
import { useEffect, useRef } from "react";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import { CloseButton, HUD_FONT } from "./world-2d-hud-chrome.tsx";
import { insidePond, type TileRect } from "./world-2d-layout.ts";
import {
	needsYou,
	type VillagerStatus,
	villagerStatusSuffix,
} from "./world-2d-model.ts";
import { type PixelScene, SV_MAP } from "./world-2d-palette.ts";
import type { VillageLayout } from "./world-village.ts";

/** Pixels per tile on the map. */
const MAP_TILE = 4;
/** Widest the map canvas may draw (CSS px). */
const MAP_MAX_WIDTH = 384;
/** Largest zoom of the map's pixels. */
const MAP_MAX_ZOOM = 6;

/**
 * The paved square on the map: a lit curb along its top, then stones laid
 * in running bond (half a tile offset each row) in two tones over the
 * mortar, so it reads as paving rather than a flat band.
 */
function drawMapPlaza(
	context: CanvasRenderingContext2D,
	pixel: PixelScene,
	village: VillageLayout,
	width: number
): void {
	const t = MAP_TILE;
	const top = village.plaza.top * t;
	const rows = (village.plaza.bottom - village.plaza.top + 1) * t;
	context.fillStyle = pixel.cobble.gap;
	context.fillRect(0, top, width * t, rows);
	const half = t / 2;
	for (let row = 0; row * half < rows; row++) {
		const y = top + row * half;
		const offset = row % 2 === 0 ? 0 : -half;
		for (let x = offset, n = 0; x < width * t; x += t, n++) {
			context.fillStyle =
				(n + row) % 3 === 0 ? pixel.cobble.stones[2] : pixel.cobble.stones[0];
			context.fillRect(Math.max(0, x), y, t - 1 + Math.min(0, x), half - 1);
		}
	}
	context.fillStyle = pixel.cobble.curb[0];
	context.fillRect(0, top, width * t, 1);
}

/**
 * A flat pixel map of the village with villagers and the player, under a
 * plank with the place's name and Stardew's close "X". Each cottage names
 * its villager on hover or focus, and clicking one walks over to talk.
 */
export function VillageMap({
	layout,
	maxWidth = MAP_MAX_WIDTH,
	nearbyId,
	onClose,
	onVisit,
	pixel,
	player,
	pond,
	roofs,
	statuses,
	title,
	village,
}: {
	layout: WorldLayout;
	/** Widest the map canvas may draw here (CSS px). */
	maxWidth?: number;
	nearbyId: string | null;
	onClose: () => void;
	onVisit: (agentId: string) => void;
	pixel: PixelScene;
	pond: TileRect | null;
	player: WorldPoint;
	roofs: ReadonlyMap<string, string>;
	statuses: ReadonlyMap<string, VillagerStatus>;
	/** The place's name, on the plank above the map. */
	title: string;
	village: VillageLayout;
}) {
	const tl = useLiteralMessages();
	const ref = useRef<HTMLCanvasElement>(null);
	// The largest whole-pixel zoom that fits the space it is given.
	const scale = Math.min(
		MAP_MAX_ZOOM,
		Math.max(
			1,
			Math.floor(Math.min(maxWidth, MAP_MAX_WIDTH) / (layout.width * MAP_TILE))
		)
	);
	useEffect(() => {
		const context = ref.current?.getContext("2d");
		if (!context) {
			return;
		}
		const t = MAP_TILE;
		context.imageSmoothingEnabled = false;
		context.fillStyle = pixel.indoor ? pixel.grass[0] : pixel.grass[1];
		context.fillRect(0, 0, layout.width * t, layout.height * t);
		context.fillStyle = pixel.dirt.fill;
		for (const key of village.paths) {
			const [x = 0, y = 0] = key.split(",").map(Number);
			context.fillRect(x * t, y * t, t, t);
		}
		drawMapPlaza(context, pixel, village, layout.width);
		if (pond) {
			context.fillStyle = pixel.water.fill;
			context.fillRect(
				pond.x * t + 1,
				pond.y * t + 1,
				pond.w * t - 2,
				pond.h * t - 2
			);
		}
		for (const tree of village.trees) {
			if (insidePond(pond, tree.x, tree.y)) {
				continue;
			}
			context.fillStyle = pixel.indoor
				? SV_MAP.indoorTree
				: pixel.tree.oak.dark;
			context.fillRect(tree.x * t, tree.y * t + 1, t, t - 1);
			context.fillStyle = pixel.indoor
				? SV_MAP.indoorTreeLight
				: pixel.tree.oak.mid;
			context.fillRect(tree.x * t + 1, tree.y * t, t - 2, t - 1);
		}
		for (const house of village.houses) {
			context.fillStyle = SV_MAP.edge;
			context.fillRect(house.x * t, house.y * t, house.w * t, house.h * t);
			context.fillStyle = roofs.get(house.agentId) ?? SV_MAP.roof;
			context.fillRect(
				house.x * t + 1,
				house.y * t + 1,
				house.w * t - 2,
				house.h * t - 3
			);
		}
		for (const entity of layout.entities) {
			const near = entity.agentId === nearbyId;
			const status = statuses.get(entity.agentId) ?? "idle";
			context.fillStyle = SV_MAP.edge;
			context.fillRect(
				entity.x * t - (near ? 1 : 0),
				entity.y * t - (near ? 1 : 0),
				t + (near ? 2 : 0),
				t + (near ? 2 : 0)
			);
			let fill: string = SV_MAP.idle;
			if (needsYou(status)) {
				fill = SV_MAP.alert;
			} else if (status === "working") {
				fill = SV_MAP.working;
			}
			context.fillStyle = fill;
			context.fillRect(entity.x * t + 1, entity.y * t + 1, t - 2, t - 2);
		}
		context.fillStyle = SV_MAP.playerRim;
		context.fillRect(player.x * t - 1, player.y * t - 1, t + 2, t + 2);
		context.fillStyle = SV_MAP.player;
		context.fillRect(player.x * t, player.y * t, t, t);
	}, [layout, nearbyId, pixel, player, pond, roofs, statuses, village]);
	const working = layout.entities.filter(
		(entity) => entity.status === "working"
	).length;
	const names = new Map(
		layout.entities.map((entity) => [entity.agentId, entity.name])
	);
	const zoom = MAP_TILE * scale;
	const legend = (color: string, label: string) => (
		<span className="inline-flex h-5 items-center gap-2">
			<span
				aria-hidden="true"
				className="block size-2.5 shrink-0 -translate-y-px border border-(--sv-outline)"
				style={{ backgroundColor: color }}
			/>
			{label}
		</span>
	);
	return (
		<div className="pointer-events-auto flex flex-col items-stretch gap-2">
			<div className="flex items-center justify-between gap-2">
				<span aria-hidden="true" className="size-8 shrink-0" />
				<h2
					className={cn("px-1 text-[16px] leading-5", HUD_FONT)}
					style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
				>
					{title}
				</h2>
				<CloseButton
					keyShortcut="Escape"
					label="Close map"
					onClick={onClose}
					title="Close map (Esc)"
				/>
			</div>
			<figure style={frameStyle("wood")}>
				<div
					className="relative mx-auto"
					style={{
						height: layout.height * zoom,
						width: layout.width * zoom,
					}}
				>
					<canvas
						aria-label={tl(
							"Village map: {count} villagers, {working} working",
							{
								count: String(layout.entities.length),
								working: String(working),
							}
						)}
						className="block size-full [image-rendering:pixelated]"
						height={layout.height * MAP_TILE}
						ref={ref}
						role="img"
						width={layout.width * MAP_TILE}
					/>
					{village.houses.map((house) => {
						const name = names.get(house.agentId) ?? "Villager";
						const status = statuses.get(house.agentId) ?? "idle";
						return (
							<button
								aria-label={tl("Visit {name}{suffix}", {
									name,
									suffix: villagerStatusSuffix(status),
								})}
								className="group absolute outline-none hover:shadow-[inset_0_0_0_2px_var(--sv-plank-ink)] focus-visible:shadow-[inset_0_0_0_2px_var(--sv-focus)]"
								key={house.agentId}
								onClick={() => onVisit(house.agentId)}
								style={{
									height: house.h * zoom,
									left: house.x * zoom,
									top: house.y * zoom,
									width: house.w * zoom,
								}}
								type="button"
							>
								<span
									aria-hidden="true"
									className={cn(
										"absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap text-[16px] leading-5 group-hover:block group-focus-visible:block",
										HUD_FONT
									)}
									style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
								>
									{name}
								</span>
							</button>
						);
					})}
				</div>
				<figcaption
					className={cn(
						"mt-2 flex flex-wrap items-center gap-x-4 px-1 text-[16px] leading-5",
						HUD_FONT
					)}
					style={SV_TEXT}
				>
					{legend(SV_MAP.player, "You")}
					{legend(SV_MAP.alert, "Needs you")}
					{legend(SV_MAP.working, "Working")}
				</figcaption>
			</figure>
		</div>
	);
}
