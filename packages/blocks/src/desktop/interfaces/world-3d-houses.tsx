import type { WorldLayout } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	buildCottages,
	ChimneySmoke,
	CottageLamps,
	CottageMeshes,
	type CottageSpec,
	chimneyTop,
	doorWood,
	shareLamps,
} from "./game3d-cottages.tsx";
import {
	type AgentSwatch,
	type Scene3dTheme,
	swatchOf,
} from "./game3d-palette.ts";
import { OfficePods } from "./world-3d-office.tsx";
import { tileToWorld } from "./world-3d-theme.ts";
import {
	tileHash,
	type VillageHouse,
	type VillageLayout,
} from "./world-village.ts";

/**
 * Which side of a house faces the village center: 1 for houses left of the
 * center, -1 right of it. The lamp stands on that side, toward the open
 * village and away from the rim forest.
 */
function lampSide(worldX: number): 1 | -1 {
	return worldX > 0.25 ? -1 : 1;
}

/**
 * A village house as a kit cottage (game3d-cottages.tsx): centred on its
 * plot, with its chimney side, door wood and porch from its plot's hash.
 */
function cottageFor(
	layout: WorldLayout,
	house: VillageHouse,
	swatches: ReadonlyMap<string, AgentSwatch>,
	working: ReadonlySet<string>,
	pips?: { done: number; total: number }
): CottageSpec {
	const origin = tileToWorld(layout, {
		x: house.x + (house.w - 1) / 2,
		y: house.y + (house.h - 1) / 2,
	});
	const hash = tileHash(house.x, house.y);
	return {
		chimneySide: hash % 2 === 0 ? 1 : -1,
		door: doorWood(Math.floor(hash / 2)),
		lit: working.has(house.agentId),
		origin,
		pips,
		porch: Math.floor(hash / 6) % 2 === 0,
		seed: hash,
		swatch: swatchOf(swatches, house.agentId),
		yard: lampSide(origin[0]),
	};
}

/**
 * One cottage per agent on its 3x2 plot: cream timber-framed walls, a gable
 * facing the street under a roof in the agent's color, a door facing the
 * agent, and windows that glow while the agent works. Cottages listed in
 * `ghosts` (between the conversation camera and the pair) are drawn
 * see-through. The office theme swaps cottages for cubicle pods.
 */
export function Houses({
	ghosts,
	layout,
	reducedMotion,
	swatches,
	pips,
	theme,
	village,
	working,
}: {
	ghosts: ReadonlySet<string>;
	/**
	 * With acts, a working agent's plan or workflow steps (never an
	 * estimate): its windows light one per share of the steps done.
	 */
	pips?: ReadonlyMap<string, { done: number; total: number }>;
	layout: WorldLayout;
	reducedMotion: boolean;
	swatches: ReadonlyMap<string, AgentSwatch>;
	theme: Scene3dTheme;
	village: VillageLayout;
	working: ReadonlySet<string>;
}) {
	const cottages = useMemo(
		() =>
			village.houses.map((house) => ({
				agentId: house.agentId,
				spec: cottageFor(
					layout,
					house,
					swatches,
					working,
					pips?.get(house.agentId)
				),
			})),
		[layout, pips, swatches, village, working]
	);
	const parts = useMemo(
		() =>
			buildCottages(
				cottages
					.filter((item) => !ghosts.has(item.agentId))
					.map((item) => item.spec),
				theme
			),
		[cottages, ghosts, theme]
	);
	const ghostParts = useMemo(
		() =>
			ghosts.size === 0
				? null
				: buildCottages(
						cottages
							.filter((item) => ghosts.has(item.agentId))
							.map((item) => item.spec),
						theme
					),
		[cottages, ghosts, theme]
	);
	const lamps = useMemo(
		() =>
			ghostParts
				? shareLamps([...parts.lamps, ...ghostParts.lamps])
				: parts.lamps,
		[ghostParts, parts]
	);
	const chimneys = useMemo(
		() =>
			cottages
				.filter((item) => item.spec.lit && !ghosts.has(item.agentId))
				.map((item) => chimneyTop(item.spec)),
		[cottages, ghosts]
	);
	if (theme.rim === "walls") {
		return (
			<OfficePods
				layout={layout}
				swatches={swatches}
				village={village}
				working={working}
			/>
		);
	}
	return (
		<group>
			<CottageMeshes parts={parts} theme={theme} />
			{ghostParts ? (
				<CottageMeshes ghost parts={ghostParts} theme={theme} />
			) : null}
			<CottageLamps lamps={lamps} theme={theme} />
			{chimneys.length > 0 ? (
				<ChimneySmoke
					chimneys={chimneys}
					color={theme.night ? theme.skyHorizon : theme.smoke}
					night={theme.night}
					reducedMotion={reducedMotion}
				/>
			) : null}
		</group>
	);
}
