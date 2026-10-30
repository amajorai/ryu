import type {
	InterfacePort,
	WorldLayout,
	WorldPoint,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import type { actTotals } from "./game3d-acts.ts";
import type {
	useTalkingAgent,
	useWorldController,
} from "./use-world-controller.ts";
import {
	ClockBox,
	ControlsPlank,
	ControlsToggle,
	EmptyVillage,
	HelpButton,
	Hotbar,
	HotbarPlaceholder,
	LocationPlaque,
	PixelKey,
	PromptTooltip,
	VillageMap,
} from "./world-2d-hud.tsx";
import {
	CLOCK_ROOM,
	HINT_MIN_WIDTH,
	HUD_INSET,
	type useViewportSize,
} from "./world-2d-interface-hooks.ts";
import type { useWorld2dHotbar } from "./world-2d-interface-hotbar.ts";
import type { villageProps } from "./world-2d-layout.ts";
import { countNeedingYou, type VillagerStatus } from "./world-2d-model.ts";
import type { PIXEL_SCENES } from "./world-2d-palette.ts";
import type { villageRoofColors } from "./world-themes.ts";
import type { layoutVillage } from "./world-village.ts";

/** The village's HUD: the hint, the clock, the prompt, the hotbar and map. */
export function World2dHud({
	furniture,
	hotbarView,
	indoor,
	layout,
	loading,
	nearbyId,
	pixel,
	port,
	roofs,
	shownPlayer,
	statuses,
	talkingAgent,
	talkingId,
	title,
	totals,
	viewport,
	village,
	withActs,
	world,
}: {
	furniture: ReturnType<typeof villageProps>;
	hotbarView: ReturnType<typeof useWorld2dHotbar>;
	indoor: boolean;
	layout: WorldLayout;
	loading: boolean;
	nearbyId: string | null;
	pixel: (typeof PIXEL_SCENES)[keyof typeof PIXEL_SCENES];
	port: InterfacePort;
	roofs: ReturnType<typeof villageRoofColors>;
	shownPlayer: WorldPoint;
	statuses: ReadonlyMap<string, VillagerStatus>;
	talkingAgent: ReturnType<typeof useTalkingAgent>["talkingAgent"];
	talkingId: string | null;
	title: string;
	totals: ReturnType<typeof actTotals>;
	viewport: ReturnType<typeof useViewportSize>;
	village: ReturnType<typeof layoutVillage>;
	withActs: boolean;
	world: ReturnType<typeof useWorldController>;
}) {
	const {
		bar,
		hint,
		hotbar,
		hotbarAgents,
		mapOpen,
		nearbyAsk,
		pageSize,
		talkTo,
		toggleHint,
		toggleMap,
		turnPage,
		visitFromMap,
	} = hotbarView;
	const empty = !loading && layout.entities.length === 0;
	const settled = !(loading || empty);
	// The controls hint sits in the top-left corner, clear of the clock, the
	// hotbar and the square's sign; on a narrow stage it sits above the
	// hotbar's left end instead (and starts closed there).
	const hintRoom = viewport.size.width - HUD_INSET * 2 - CLOCK_ROOM;
	const hintOnTop = hintRoom >= HINT_MIN_WIDTH;
	let prompt: ReactNode = null;
	if (talkingAgent) {
		// The talk panel carries its own Walk away button (and Esc).
		prompt = null;
	} else if (world.nearby) {
		prompt = (
			<span className="inline-flex items-center gap-2">
				<PixelKey>E</PixelKey>
				<span>
					{nearbyAsk ? "Answer" : "Talk to"}{" "}
					<span className="text-(--sv-gold)">{world.nearby.name}</span>
				</span>
			</span>
		);
	} else if (loading) {
		prompt = "Loading villagers";
	}
	let controls: ReactNode = null;
	if (hint.open && settled) {
		const visitable = Math.min(pageSize, hotbarAgents.length);
		controls = (
			<span className="inline-flex flex-wrap items-center gap-x-4 gap-y-2">
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>WASD</PixelKey>
					Walk
				</span>
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>E</PixelKey>
					Talk
				</span>
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>{visitable === 1 ? "1" : `1–${visitable % 10}`}</PixelKey>
					Visit
				</span>
				{hotbar.pageCount > 1 ? (
					<span className="inline-flex items-center gap-1.5">
						<PixelKey>[</PixelKey>
						<PixelKey>]</PixelKey>
						Page
					</span>
				) : null}
				<span className="inline-flex items-center gap-1.5">
					<PixelKey>M</PixelKey>
					Map
				</span>
			</span>
		);
	}
	// With acts the clock counts what the acts say.
	const needYouCount = withActs ? totals.needYou : countNeedingYou(statuses);
	const workingCount = withActs
		? totals.working
		: layout.entities.filter((entity) => entity.status === "working").length;
	return (
		<div
			className="pointer-events-none absolute inset-0 z-[400] select-none"
			data-testid="world-hud"
		>
			<div className="absolute top-3 left-3 flex items-start gap-2">
				{/* Outdoors the village sign names the place. */}
				{indoor ? <LocationPlaque title={title} /> : null}
				{bar.helpInBar || !settled ? null : (
					<HelpButton onToggle={toggleHint} open={hint.open} size={42} />
				)}
				{controls && hintOnTop ? (
					<div style={{ maxWidth: hintRoom }}>
						<ControlsPlank>{controls}</ControlsPlank>
					</div>
				) : null}
				{/* Where the strip was: a small plank that brings it back. */}
				{bar.helpInBar && hintOnTop && settled && !hint.open ? (
					<ControlsToggle onToggle={toggleHint} />
				) : null}
			</div>
			<div className="absolute top-3 right-3 flex flex-col items-end gap-2">
				<ClockBox
					compact={viewport.size.width < 760}
					needYouCount={needYouCount}
					showStatus={settled}
					workingCount={workingCount}
				/>
			</div>
			{empty ? <EmptyVillage onStart={() => port.startThread({})} /> : null}
			<div className="absolute inset-x-3 bottom-3 flex flex-col items-center gap-2">
				{controls && !hintOnTop ? (
					<div className="max-w-full self-start">
						<ControlsPlank>{controls}</ControlsPlank>
					</div>
				) : null}
				<PromptTooltip visuallyHidden={loading && !world.nearby}>
					{prompt}
				</PromptTooltip>
				{loading ? <HotbarPlaceholder size={bar.size} /> : null}
				{settled ? (
					<Hotbar
						activeId={talkingId ?? nearbyId}
						agents={hotbarAgents}
						helpInBar={bar.helpInBar}
						helpOpen={hint.open}
						mapOpen={mapOpen}
						onPage={turnPage}
						onToggleHelp={toggleHint}
						onToggleMap={toggleMap}
						onVisit={talkTo}
						page={hotbar.page}
						pageCount={hotbar.pageCount}
						size={bar.size}
					/>
				) : null}
			</div>
			{mapOpen && settled ? (
				<div className="absolute inset-0 z-10 flex items-center justify-center p-3">
					{/* Clicking off the map closes it; the visible "X" (and Esc
					    or M) are the accessible ways out. */}
					<button
						aria-hidden="true"
						className="pointer-events-auto absolute inset-0 cursor-default bg-(--sv-outline)/45 outline-none"
						onClick={toggleMap}
						tabIndex={-1}
						type="button"
					/>
					<div className="relative">
						<VillageMap
							layout={layout}
							maxWidth={viewport.size.width - 64}
							nearbyId={nearbyId}
							onClose={toggleMap}
							onVisit={visitFromMap}
							pixel={pixel}
							player={shownPlayer}
							pond={furniture.pond}
							roofs={roofs}
							statuses={statuses}
							title={title}
							village={village}
						/>
					</div>
				</div>
			) : null}
		</div>
	);
}
