/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import { type InterfaceAsk, waitBand } from "@ryuhq/protocol/interfaces";
import { useRef } from "react";
import type { Mesh } from "three";
import { GAME_PLATE } from "./game-hud.tsx";
import type { YouSpotLayout } from "./game3d-act-stage.tsx";
import type { YouSlot } from "./game3d-acts.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { bandColor } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { type DeskLayout, deskPoint } from "./passport-desk.tsx";
import { PASSPORT_ACT_ART } from "./passport-palette.ts";

/**
 * The customs desk's places in desk coordinates (across, toward): the
 * queue "you-1".."you-4" in a row before the booklet's front edge, front
 * first from the desk leftward, "you-tray" on the desk, "you" before it
 * (an ask with no queue place left), the desk itself and its lamp.
 */
export const CUSTOMS = {
	single: {
		desk: [2.4, 4.5],
		lamp: [3.9, 4.2],
		// Clear of a left tab's status board, which hangs below the page.
		slots: [
			[-1.0, 1.45],
			[2.0, 1.45],
			[-1.0, 2.95],
			[2.0, 2.95],
		],
		tally: [-3.9, 3.8],
		tray: [0.2, 4.4],
		you: [-0.2, 3.7],
	},
	spread: {
		desk: [3.6, 2.7],
		lamp: [5.8, 2.4],
		slots: [
			[-0.6, 1.85],
			[-3.4, 1.85],
			[-6.2, 1.85],
			[-9.0, 1.85],
		],
		tally: [-8.6, 2.9],
		tray: [2.8, 2.6],
		you: [1.6, 1.7],
	},
} as const;

export function customs(
	layout: DeskLayout,
	point: readonly [number, number],
	y = 0
) {
	return deskPoint(point[0], layout.halfB + point[1], y);
}

/** The customs desk's places on the desk (world). */
export function customsPoints(layout: DeskLayout): Record<string, Vec3> {
	const plan = CUSTOMS[layout.mode];
	const points: Record<string, Vec3> = {
		you: customs(layout, plan.you),
		"you-tray": customs(layout, plan.tray),
	};
	for (const [index, slot] of plan.slots.entries()) {
		points[`you-${index + 1}`] = customs(layout, slot);
	}
	return points;
}

/** The waypoints: the customs places and every tab (where slips start). */
export function deskPaths(layout: DeskLayout): LifePaths {
	const points: Record<string, Vec3> = { ...customsPoints(layout) };
	const links: [string, string][] = [];
	for (const station of layout.stations) {
		if (!station.country) {
			continue;
		}
		const id = `tab-${station.country.agent.id}`;
		points[id] = station.at;
		links.push([id, "you"]);
	}
	return { links, points };
}

/** Where the kit's you-spot pieces sit at the customs desk. */
export function customsLayout(layout: DeskLayout): YouSpotLayout {
	const plan = CUSTOMS[layout.mode];
	const points = customsPoints(layout);
	const at = (id: YouSlot): Vec3 => points[id] ?? [0, 0, 0];
	const tray = customs(layout, plan.tray, 0.55);
	const step = deskPoint(0.55, 0);
	return {
		offStage: customs(layout, plan.tally),
		slots: {
			"you-1": at("you-1"),
			"you-2": at("you-2"),
			"you-3": at("you-3"),
			"you-4": at("you-4"),
		},
		tally: customs(layout, plan.tally, 0.6),
		timer: deskPoint(0.55, 0.25),
		tray,
		trayStep: step,
	};
}

/**
 * The customs desk: a small counter with its lamp, which burns in the
 * band colour of the oldest ask waiting (first in `compareAsks` order) and
 * pulses only in the last two minutes before an expiry, never under
 * reduced motion.
 */
export function CustomsDesk({
	at,
	first,
	lampAt,
	nowMs,
	reduced,
}: {
	at: Vec3;
	first: InterfaceAsk | undefined;
	lampAt: Vec3;
	nowMs: number;
	reduced: boolean;
}) {
	const bulb = useRef<Mesh>(null);
	const since = first?.since ? Date.parse(first.since) : null;
	const until = first?.expiresAt ? Date.parse(first.expiresAt) : null;
	const band = first ? waitBand(since, nowMs, until) : "unknown";
	const pulse = band === "expiring" && !reduced;
	useFrame(({ clock }) => {
		const node = bulb.current;
		if (!node) {
			return;
		}
		node.scale.setScalar(
			pulse ? 1 + Math.sin(clock.elapsedTime * 6) * 0.18 : 1
		);
	});
	return (
		<group>
			<group position={at} rotation={[0, Math.PI / 4, 0]}>
				<ToonMesh
					castShadow
					color={PASSPORT_ACT_ART.stampHandle}
					ink={0.02}
					position={[0, 0.25, 0]}
				>
					<boxGeometry args={[1.9, 0.5, 0.8]} />
				</ToonMesh>
				<ToonMesh
					color={PASSPORT_ACT_ART.page}
					ink={0.012}
					position={[0, 0.53, 0]}
				>
					<boxGeometry args={[2.0, 0.06, 0.9]} />
				</ToonMesh>
			</group>
			<group position={lampAt}>
				<ToonMesh
					castShadow
					color={PASSPORT_ACT_ART.lampStand}
					ink={0.015}
					position={[0, 0.05, 0]}
				>
					<cylinderGeometry args={[0.28, 0.32, 0.1, 16]} />
				</ToonMesh>
				<ToonMesh color={PASSPORT_ACT_ART.lampStand} position={[0, 0.6, 0]}>
					<cylinderGeometry args={[0.04, 0.04, 1.1, 8]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={PASSPORT_ACT_ART.lampShade}
					ink={0.015}
					position={[0, 1.2, 0]}
				>
					<coneGeometry args={[0.36, 0.42, 16, 1, true]} />
				</ToonMesh>
				<mesh position={[0, 1.02, 0]} ref={bulb}>
					<sphereGeometry args={[0.16, 14, 10]} />
					<meshBasicMaterial
						color={first ? bandColor(band) : PASSPORT_ACT_ART.bulb}
						toneMapped={false}
					/>
				</mesh>
			</group>
		</group>
	);
}

/** The customs desk's empty-state line. */
export const NO_VISAS_WAITING = "No visas waiting";

/**
 * The customs desk with no act layer (a host that sends no asks): the
 * counter and its unlit lamp at the booklet's front edge, and a plate on
 * the counter that says the desk is empty.
 */
export function EmptyCustomsDesk({ layout }: { layout: DeskLayout }) {
	const plan = CUSTOMS[layout.mode];
	return (
		<group>
			<CustomsDesk
				at={customs(layout, plan.desk)}
				first={undefined}
				lampAt={customs(layout, plan.lamp)}
				nowMs={0}
				reduced
			/>
			<group position={customs(layout, plan.desk, 0.95)}>
				<Html center zIndexRange={[18, 0]}>
					<p
						className={cn(
							GAME_PLATE,
							"gk-display pointer-events-none flex h-7 select-none items-center whitespace-nowrap rounded-full px-2.5 text-(--gk-ink-muted) text-[12px] leading-none"
						)}
						data-customs-empty=""
						data-iso-plate=""
					>
						{NO_VISAS_WAITING}
					</p>
				</Html>
			</group>
		</group>
	);
}
