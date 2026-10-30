/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import { Bushes, type PlacedBush, PROP_INK } from "./game3d-props.tsx";
import type { DeskActivity } from "./workers-acts.tsx";
import {
	DESK_TOP,
	DESK_WIDTH,
	DESK_YAW,
	facingOf,
	SCREEN,
	SCREEN_Y,
	SEAT,
	SEAT_X,
	SLAB,
	turned,
} from "./workers-diorama-geometry.ts";
import { CHAIR_OUT, DESK_DEPTH, type OfficeDesk } from "./workers-model.ts";
import { swatch, type WorkersArt } from "./workers-palette.ts";

interface DeskParts {
	bezels: InstanceSpec[];
	cabinets: InstanceSpec[];
	chairBacks: InstanceSpec[];
	chairBases: InstanceSpec[];
	chairSeats: InstanceSpec[];
	drawers: InstanceSpec[];
	keyboards: InstanceSpec[];
	/** Keys lit while the worker types (edits or writes). */
	keyGlows: InstanceSpec[];
	lampBulbs: Vec3[];
	lampShades: InstanceSpec[];
	legs: InstanceSpec[];
	mugs: InstanceSpec[];
	plants: PlacedBush[];
	pots: InstanceSpec[];
	screens: InstanceSpec[];
	/** A terminal's lines of text on its screen. */
	terminalLines: InstanceSpec[];
	tops: InstanceSpec[];
}

/** The filing cabinet beside each desk, in the desk's frame. */
const CABINET: Vec3 = [1.0, 0, -0.12];
const CABINET_SIZE: Vec3 = [0.36, 0.66, 0.5];

function buildDesks(
	desks: readonly OfficeDesk[],
	art: WorkersArt,
	activity: ReadonlyMap<string, DeskActivity> | null
): DeskParts {
	const parts: DeskParts = {
		bezels: [],
		cabinets: [],
		drawers: [],
		keyGlows: [],
		chairBacks: [],
		chairBases: [],
		chairSeats: [],
		keyboards: [],
		lampBulbs: [],
		lampShades: [],
		legs: [],
		mugs: [],
		plants: [],
		pots: [],
		screens: [],
		terminalLines: [],
		tops: [],
	};
	for (const [index, { worker, x, z }] of desks.entries()) {
		const y = SLAB;
		// Each desk is laid out in its own frame (the chair toward +z) and
		// turned to face the camera, so its screen shows over its worker.
		const at: Vec3 = [x, 0, z];
		const p = (local: Vec3): Vec3 => turned(at, DESK_YAW, local);
		const turn: Vec3 = [0, DESK_YAW, 0];
		const box = (local: Vec3, scale: Vec3, color?: string): InstanceSpec => ({
			color,
			position: p(local),
			rotation: turn,
			scale,
		});
		parts.tops.push(
			box([0, y + DESK_TOP - 0.03, 0], [DESK_WIDTH, 0.06, DESK_DEPTH])
		);
		for (const side of [-1, 1]) {
			parts.legs.push(
				box(
					[side * (DESK_WIDTH / 2 - 0.08), y + DESK_TOP / 2, 0],
					[0.06, DESK_TOP, DESK_DEPTH - 0.1]
				)
			);
		}
		// The monitor on its stand at the back of the desk, facing the chair.
		const mz = -DESK_DEPTH / 2 + 0.16;
		parts.bezels.push(
			box([0, y + SCREEN_Y, mz], [SCREEN[0] + 0.08, SCREEN[1] + 0.08, 0.06]),
			box(
				[0, y + (DESK_TOP + SCREEN_Y) / 2 - 0.1, mz - 0.03],
				[0.06, SCREEN_Y - DESK_TOP - 0.1, 0.05]
			),
			box([0, y + DESK_TOP + 0.015, mz - 0.02], [0.3, 0.03, 0.18])
		);
		// The screen glows in the worker's state; a run shows a terminal.
		const doing = activity?.get(worker.id) ?? null;
		parts.screens.push(
			box(
				[0, y + SCREEN_Y, mz + 0.035],
				[SCREEN[0], SCREEN[1], 0.01],
				doing === "terminal" ? art.terminal : art.screen[worker.state]
			)
		);
		if (doing === "terminal") {
			for (const [line, width] of [0.42, 0.3, 0.52].entries()) {
				parts.terminalLines.push(
					box(
						[
							width / 2 - SCREEN[0] / 2 + 0.08,
							y + SCREEN_Y + 0.12 - line * 0.1,
							mz + 0.042,
						],
						[width, 0.035, 0.004],
						art.terminalText
					)
				);
			}
		}
		// The filing cabinet: its top drawer slides out while the worker reads.
		if (activity) {
			parts.cabinets.push(
				box([CABINET[0], y + CABINET_SIZE[1] / 2, CABINET[2]], CABINET_SIZE)
			);
			const open = doing === "cabinet" ? 0.3 : 0;
			for (const [drawer, height] of [0.5, 0.2].entries()) {
				const out = drawer === 0 ? open : 0;
				parts.drawers.push(
					box(
						[
							CABINET[0],
							y + height,
							CABINET[2] + CABINET_SIZE[2] / 2 + out / 2 - 0.005,
						],
						[CABINET_SIZE[0] - 0.06, 0.2, 0.02 + out]
					)
				);
			}
		}
		parts.keyboards.push(
			box([-0.05, y + DESK_TOP + 0.015, 0.12], [0.5, 0.025, 0.16])
		);
		if (doing === "typing") {
			parts.keyGlows.push(
				box(
					[-0.05, y + DESK_TOP + 0.03, 0.12],
					[0.44, 0.006, 0.12],
					art.screen.working
				)
			);
		}
		parts.mugs.push(
			box(
				[0.52, y + DESK_TOP + 0.07, 0.1],
				[0.06, 0.12, 0.06],
				swatch(art.mugs, index)
			)
		);
		// Every other desk a little plant, the rest a desk lamp.
		if (index % 2 === 0) {
			parts.pots.push(
				box([-0.58, y + DESK_TOP + 0.07, -0.12], [0.08, 0.14, 0.08])
			);
			parts.plants.push({
				at: p([-0.58, y + DESK_TOP + 0.1, -0.12]),
				scale: 0.42,
				seed: index * 5 + 2,
			});
		} else {
			parts.lampShades.push(
				box([-0.58, y + DESK_TOP + 0.36, -0.14], [0.14, 0.12, 0.14])
			);
			parts.legs.push(
				box([-0.58, y + DESK_TOP + 0.15, -0.2], [0.025, 0.3, 0.025])
			);
			parts.lampBulbs.push(p([-0.58, y + DESK_TOP + 0.3, -0.14]));
		}
		// The office chair, turned with its worker.
		const yaw = facingOf(worker.state);
		const seat = p([SEAT_X, y, CHAIR_OUT]);
		parts.chairSeats.push({
			position: [seat[0], y + SEAT - 0.04, seat[2]],
			rotation: [0, yaw, 0],
			scale: [0.42, 0.08, 0.4],
		});
		parts.chairBacks.push({
			position: turned([seat[0], y, seat[2]], yaw, [0, SEAT + 0.24, -0.2]),
			rotation: [0, yaw, 0],
			scale: [0.4, 0.42, 0.07],
		});
		parts.chairBases.push(
			{
				position: [seat[0], y + SEAT / 2 - 0.04, seat[2]],
				scale: [0.04, SEAT - 0.08, 0.04],
			},
			{
				position: [seat[0], y + 0.03, seat[2]],
				scale: [0.3, 0.04, 0.3],
			}
		);
	}
	return parts;
}

/** The desks, monitors, chairs and desk clutter, every part instanced. */
export function Desks({
	activity,
	art,
	desks,
	night,
	theme,
}: {
	/** With acts, each desk's activity (and a filing cabinet per desk). */
	activity: ReadonlyMap<string, DeskActivity> | null;
	art: WorkersArt;
	desks: readonly OfficeDesk[];
	night: boolean;
	theme: Scene3dTheme;
}) {
	const parts = useMemo(
		() => buildDesks(desks, art, activity),
		[activity, art, desks]
	);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={art.deskLeg}
				items={parts.tops}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.deskTop} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.legs}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.deskLeg} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.8}
				inkColor={art.bezel}
				items={parts.bezels}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.bezel} />
			</InstancedParts>
			<InstancedParts items={parts.screens}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts items={parts.keyGlows}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts items={parts.terminalLines}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial toneMapped={false} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.8}
				inkColor={art.chairBase}
				items={parts.cabinets}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cabinet} />
			</InstancedParts>
			<InstancedParts items={parts.drawers}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cabinetDrawer} />
			</InstancedParts>
			<InstancedParts items={parts.keyboards}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.keyboard} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.mugs}>
				<cylinderGeometry args={[1, 0.85, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.pots}>
				<cylinderGeometry args={[1, 0.75, 1, 12]} />
				<ToonMaterial color={art.pot} />
			</InstancedParts>
			<Bushes bushes={parts.plants} theme={theme} />
			<InstancedParts castShadow items={parts.lampShades}>
				<coneGeometry args={[1, 1, 14, 1, true]} />
				<ToonMaterial color={art.lampShade} side={2} />
			</InstancedParts>
			<InstancedParts
				items={parts.lampBulbs.map((at) => ({ position: at, scale: 0.05 }))}
			>
				<sphereGeometry args={[1, 10, 8]} />
				{night ? (
					<CurvedBasicMaterial color={art.lampBulb} toneMapped={false} />
				) : (
					<ToonMaterial color={art.lampBulb} />
				)}
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.chairBase}
				items={parts.chairSeats}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.chair} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.chairBase}
				items={parts.chairBacks}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.chair} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.chairBases}>
				<cylinderGeometry args={[1, 1, 1, 10]} />
				<ToonMaterial color={art.chairBase} />
			</InstancedParts>
			{night
				? parts.lampBulbs
						.slice(0, 4)
						.map((at) => (
							<pointLight
								color={art.lampBulb}
								decay={2}
								distance={3}
								intensity={1.2}
								key={`${at[0]}:${at[2]}`}
								position={[at[0], at[1] + 0.2, at[2] + 0.2]}
							/>
						))
				: null}
		</group>
	);
}
