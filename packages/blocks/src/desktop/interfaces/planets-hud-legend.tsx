import { useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
} from "@ryuhq/protocol/interfaces";
import { GAME_PLATE } from "./game-hud.tsx";
import type { PlanetSystem } from "./planets-model.ts";
import { type PlanetsPalette, teamColor } from "./planets-palette.ts";
import { PlanetsStatusDot, TeamMark } from "./planets-parts.tsx";

/** Keys in the legend: bordered so they read on glass in every theme. */
const KEY =
	"border-2 border-(--gk-edge) bg-(--gk-plate-sunk) text-(--gk-ink) shadow-none";

/** Bottom-left: what moon colors mean, team orbit tints, and the controls. */
export function PlanetsLegend({
	bare = false,
	palette,
	system,
}: {
	/** Inside the phone's bottom sheet: no plate of its own, always shown. */
	bare?: boolean;
	palette: PlanetsPalette;
	system: PlanetSystem;
}) {
	const tl = useLiteralMessages();
	return (
		<section
			aria-label="Legend"
			className={cn(
				"pointer-events-auto flex max-w-full flex-col gap-2 px-4 py-2.5",
				bare ? null : cn(GAME_PLATE, "@max-[620px]:hidden")
			)}
			data-planets-hud={bare ? undefined : "legend"}
		>
			<div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
				<span className="gk-display text-(--gk-ink) text-[15px]">Moons</span>
				<ul className="contents">
					{THREAD_STATUS_ORDER.map((status) => (
						<li
							className="flex items-center gap-1.5 whitespace-nowrap font-semibold text-(--gk-ink) text-[13px]"
							key={status}
						>
							<PlanetsStatusDot status={status} />
							{THREAD_STATUS_LABELS[status]}
						</li>
					))}
				</ul>
			</div>
			<div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 font-medium text-(--gk-ink-muted) text-[13px]">
				{system.teams.length > 0 ? (
					<ul aria-label="Team orbits" className="contents">
						{system.teams.map((team) => (
							<li
								className="flex items-center gap-1.5 whitespace-nowrap"
								key={team.id}
							>
								<TeamMark
									className="w-5"
									color={teamColor(palette, team.colorIndex)}
								/>
								{tl("{name} orbits", { name: team.name })}
							</li>
						))}
					</ul>
				) : null}
				<span className="flex @max-[860px]:hidden items-center gap-1.5 whitespace-nowrap">
					Drag to orbit · Scroll to zoom ·
					<span className="flex items-center gap-1">
						<Kbd className={KEY}>←</Kbd>
						<Kbd className={KEY}>→</Kbd>
					</span>
					visit planets
				</span>
			</div>
		</section>
	);
}
