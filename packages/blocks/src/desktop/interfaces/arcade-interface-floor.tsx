import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ComponentProps, type ReactNode, useRef } from "react";
import { ArcadeEmpty } from "./arcade-empty.tsx";
import {
	FLOOR_PADDING,
	FLOOR_TOP,
	HUD_BOTTOM,
} from "./arcade-interface-layout.ts";
import {
	bankWidth,
	type buildFloor,
	type floorFit,
	type Machine,
	SLOT_AISLE,
	SLOT_FOOTPRINT,
} from "./arcade-model.ts";
import { type ArcadePalette, carpetTile } from "./arcade-palette.ts";
import { ArcadeWall } from "./arcade-wall.tsx";
import { GAME_PLATE, GameIconButton } from "./game-hud.tsx";
import { ActStatus } from "./interface-ask-card.tsx";
import type { useActs } from "./use-acts.ts";

const LOADING_CABINETS = ["one", "two", "three", "four"];

type StatusProps = ComponentProps<typeof ActStatus>;

/** The flat floor: the 2D aisle of cabinets, and the loading and empty states. */
export function ArcadeFloorView({
	acts,
	baseId,
	cabinet,
	clearFilter,
	clock,
	compact,
	empty,
	filters,
	fit,
	floor,
	hintId,
	hudWidth,
	loading,
	newGame,
	nowMs,
	onAsk,
	onBlocker,
	palette,
	reduced,
	sheetCover,
	snapshot,
	withActs,
}: {
	acts: ReturnType<typeof useActs>["acts"];
	baseId: string;
	cabinet: (machine: Machine, zoom: number, describedBy?: string) => ReactNode;
	clearFilter: () => void;
	clock: StatusProps["clock"];
	compact: boolean;
	empty: boolean;
	filters: boolean;
	fit: ReturnType<typeof floorFit>;
	floor: ReturnType<typeof buildFloor>;
	hintId: string;
	hudWidth: number;
	loading: boolean;
	newGame: () => void;
	nowMs: number;
	onAsk: StatusProps["onAsk"];
	onBlocker: StatusProps["onBlocker"];
	palette: ArcadePalette;
	reduced: boolean;
	sheetCover: number;
	snapshot: StatusProps["snapshot"];
	withActs: boolean;
}) {
	const tl = useLiteralMessages();
	const aisleRef = useRef<HTMLUListElement>(null);
	const walk = (direction: -1 | 1) => {
		aisleRef.current?.scrollBy({
			behavior: reduced ? "auto" : "smooth",
			left: direction * (SLOT_FOOTPRINT + SLOT_AISLE) * fit.zoom,
		});
	};
	return (
		<div
			className="absolute inset-0 flex flex-col overflow-y-auto overflow-x-hidden"
			style={{
				backgroundColor: palette.carpetBase,
				backgroundImage: carpetTile(palette),
				paddingRight: sheetCover,
			}}
		>
			<ArcadeWall
				hudWidth={hudWidth}
				palette={palette}
				reduced={reduced}
				title={floor.filter?.name ?? "Arcade"}
				titleAs={withActs ? "p" : "h1"}
			/>
			<div className="relative flex flex-1 flex-col">
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-0"
					style={{ background: palette.floorLight }}
				/>
				{filters && !loading ? (
					<div aria-hidden="true" className="h-16 shrink-0" />
				) : null}
				{loading ? (
					<div
						aria-hidden="true"
						className="relative flex flex-1 flex-wrap content-center items-end justify-center gap-x-6 gap-y-10 p-6"
					>
						{LOADING_CABINETS.map((key) => (
							<Skeleton
								className="h-[356px] w-[200px] rounded-t-[12px] rounded-b-[4px] bg-background/20"
								key={key}
							/>
						))}
					</div>
				) : null}
				{empty && floor.filter ? (
					<ArcadeEmpty
						action="Show every machine"
						body="None of its agents have a machine on the floor yet."
						marquee="NO MACHINES"
						onAction={clearFilter}
						palette={palette}
						title={tl("No machines in {name}", {
							name: floor.filter.name,
						})}
					/>
				) : null}
				{empty && !floor.filter ? (
					<ArcadeEmpty
						action="New game"
						body="Each agent gets a slot machine here, with its three latest conversations on the reels. Start a conversation to open the floor."
						marquee="OPENING SOON"
						onAction={newGame}
						palette={palette}
						title="The floor is empty"
					/>
				) : null}
				{loading || empty ? null : (
					<div
						className="relative flex flex-1 items-center justify-center"
						style={{
							paddingBottom: compact ? 72 : HUD_BOTTOM,
							paddingInline: FLOOR_PADDING,
							paddingTop: FLOOR_TOP,
						}}
					>
						<p className="sr-only" id={hintId}>
							Tab moves between machines. Arrow keys move between a machine's
							reels, buttons, tickets and lever.
						</p>
						{fit.overflow ? (
							<div className="absolute top-1/2 left-2 z-10 -translate-y-1/2">
								<GameIconButton
									label="Walk left along the aisle"
									onClick={() => walk(-1)}
								>
									<ChevronLeft
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								</GameIconButton>
							</div>
						) : null}
						<ul
							aria-describedby={hintId}
							aria-label="Slot machines"
							className={cn(
								"flex max-w-full snap-x snap-mandatory items-end gap-x-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
								fit.overflow ? "overflow-x-auto" : "justify-center"
							)}
							ref={aisleRef}
							style={{
								width: bankWidth(fit.view),
								zoom: fit.zoom,
							}}
						>
							{floor.machines.map((machine) => {
								const act = acts.get(machine.agent.id);
								const describedBy = `${baseId}-act-${machine.id}`;
								return (
									<li className="shrink-0 snap-start pr-7" key={machine.id}>
										{cabinet(machine, fit.zoom, act ? describedBy : undefined)}
										{act ? (
											<div
												className={cn(
													GAME_PLATE,
													"mt-2 flex max-w-[200px] flex-col gap-1 p-2 text-(--gk-ink)"
												)}
											>
												<span className="sr-only" id={describedBy}>
													{act.ariaLabel}
												</span>
												<ActStatus
													act={act}
													clock={clock}
													nowMs={nowMs}
													onAsk={onAsk}
													onBlocker={onBlocker}
													snapshot={snapshot}
												/>
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
						{fit.overflow ? (
							<div className="absolute top-1/2 right-2 z-10 -translate-y-1/2">
								<GameIconButton
									label="Walk right along the aisle"
									onClick={() => walk(1)}
								>
									<ChevronRight
										aria-hidden="true"
										className="size-5"
										strokeWidth={2.5}
									/>
								</GameIconButton>
							</div>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}
