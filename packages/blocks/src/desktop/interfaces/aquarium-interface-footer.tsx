import { cn } from "@ryu/ui/lib/utils";
import { BellRing, CircleAlert, Inbox, Move3d, Sparkles } from "lucide-react";
import type { WebGLSupport } from "./aquarium-hooks.ts";
import type { AquariumActsLayer } from "./aquarium-interface-acts.ts";
import { plural, type TankSummary } from "./aquarium-model.ts";
import { BubblesGlyph, PearlGlyph } from "./aquarium-parts.tsx";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameCounter,
	GameCounters,
	GameLegend,
} from "./game-hud.tsx";
import { type IsoView, IsoZoomControls } from "./game3d-stage.tsx";

interface AquariumFooterProps {
	actsLayer: AquariumActsLayer;
	compactHud: boolean;
	isoView: IsoView;
	openUnassigned: () => void;
	summary: TankSummary;
	webgl: WebGLSupport | null;
	webglMissing: boolean;
}

/** The tank's bottom HUD: its counters, unassigned threads and legend. */
export function AquariumFooter({
	actsLayer,
	compactHud,
	isoView,
	openUnassigned,
	summary,
	webgl,
	webglMissing,
}: AquariumFooterProps) {
	const { actsOn, tally } = actsLayer;
	return (
		<footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between @min-[672px]:gap-3 gap-2 @min-[672px]:p-4 p-2.5">
			{actsOn ? (
				<GameCounters label="Tank counters">
					{tally.failed > 0 ? (
						<GameCounter
							compact={compactHud}
							icon={<CircleAlert strokeWidth={2.5} />}
							label="failed"
							tone="bad"
							value={tally.failed}
						/>
					) : null}
					<GameCounter
						compact={compactHud}
						icon={<BellRing strokeWidth={2.5} />}
						label="need you"
						tone={tally.needYou > 0 ? "warn" : "info"}
						value={tally.needYou}
					/>
					<GameCounter
						compact={compactHud}
						icon={<Sparkles strokeWidth={2.5} />}
						label="working"
						tone="good"
						value={tally.working}
					/>
				</GameCounters>
			) : (
				<GameCounters label="Tank counters">
					<GameCounter
						compact={compactHud}
						icon={<Sparkles strokeWidth={2.5} />}
						label="working"
						tone="good"
						value={summary.working}
					/>
					<GameCounter
						compact={compactHud}
						icon={<BellRing strokeWidth={2.5} />}
						label="waiting on you"
						tone={summary.yourTurn > 0 ? "warn" : "info"}
						value={summary.yourTurn}
					/>
					{summary.attention > 0 ? (
						<GameCounter
							compact={compactHud}
							icon={<CircleAlert strokeWidth={2.5} />}
							label="needs attention"
							tone="bad"
							value={summary.attention}
						/>
					) : null}
				</GameCounters>
			)}
			<div className="flex flex-col items-end @min-[672px]:gap-3 gap-2">
				{summary.unassigned > 0 ? (
					<button
						aria-label={plural(summary.unassigned, "unassigned thread")}
						className={cn(
							GAME_PLATE,
							"gk-display pointer-events-auto flex h-12 items-center gap-2 whitespace-nowrap ps-2 pe-4 text-[16px] transition-colors hover:bg-(--gk-plate-sunk)",
							GAME_FOCUS
						)}
						onClick={openUnassigned}
						type="button"
					>
						<span
							aria-hidden="true"
							className="grid size-8 place-items-center rounded-lg border-(--gk-edge) border-2 bg-(--gk-warn) text-(--gk-edge)"
						>
							<Inbox className="size-4" strokeWidth={2.5} />
						</span>
						{compactHud
							? summary.unassigned
							: plural(summary.unassigned, "unassigned thread")}
					</button>
				) : null}
				<div className="flex items-end @min-[672px]:gap-3 gap-2">
					<div className="@max-[1100px]:hidden">
						<GameLegend
							items={[
								{
									key: "bubbles",
									label: "Bubbles: working",
									mark: <BubblesGlyph className="size-4" />,
								},
								{
									key: "pearl",
									label: actsOn
										? "Pearl: run failed"
										: "Pearl: needs attention",
									mark: <PearlGlyph className="size-4" />,
								},
								// No 3D view without WebGL, so never offer to drag one.
								...(webglMissing
									? []
									: [
											{
												key: "drag",
												label: (
													<span className="@max-[860px]:hidden">
														Drag to pan
													</span>
												),
												mark: (
													<Move3d
														className="@max-[860px]:hidden size-4"
														strokeWidth={2.5}
													/>
												),
											},
										]),
								{
									key: "tab",
									label: (
										<span className="@max-[760px]:hidden">
											Visit a creature
										</span>
									),
									mark: (
										<span className="@max-[760px]:hidden rounded-md border-(--gk-edge) border-2 bg-(--gk-plate-sunk) px-1.5 font-semibold text-[12px] leading-4">
											Tab
										</span>
									),
								},
							]}
							label="Legend"
						/>
					</div>
					{webgl?.supported ? (
						<div className="pointer-events-auto">
							<IsoZoomControls view={isoView} />
						</div>
					) : null}
				</div>
			</div>
		</footer>
	);
}
