import { jitter } from "./game3d-math.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerSpec,
} from "./game3d-villager.tsx";
import { audienceSeats, TOWARD } from "./quiz-world.ts";

/** The host's and the audience's looks, keyed like agents for the kit. */
export const HOST_ID = "quiz-host";
export const AUDIENCE_IDS = Array.from(
	{ length: 13 },
	(_, index) => `quiz-audience-${index}`
);
/** Height of the stage platform the podiums stand on. */
export const STAGE_HEIGHT = 0.2;
export const STAGE_RADIUS = 3.4;
export const STAGE_STRETCH = 1.7;
/** Contestants and the host stand a head taller than the audience. */
export const STAR_SCALE = 1.3;
/** Faces toward the stage (away from the camera). */
export const FACE_STAGE = FACE_CAMERA + Math.PI;

/**
 * The studio's cast besides the contestants: the host beside the lectern,
 * then (with the "Audience" setting on) a seated crowd in the theatre rows.
 */
export function studioExtras(
	looks: ReadonlyMap<string, MemberLooks>,
	[hostX, hostZ]: readonly [number, number],
	audience = true
): VillagerSpec[] {
	const out: VillagerSpec[] = [];
	const host = looks.get(HOST_ID);
	if (host) {
		out.push({
			id: HOST_ID,
			label: "The host",
			looks: host,
			name: "Host",
			pose: "idle",
			position: [
				hostX - TOWARD[0] * 0.65,
				STAGE_HEIGHT,
				hostZ - TOWARD[1] * 0.65,
			],
			scale: STAR_SCALE,
		});
	}
	for (const [index, seat] of (audience ? audienceSeats() : []).entries()) {
		const id = AUDIENCE_IDS[index];
		const base = id ? looks.get(id) : undefined;
		if (!(id && base) || jitter(index, 3, 11) > 0.82) {
			continue;
		}
		out.push({
			facing: FACE_STAGE,
			id,
			label: "Audience",
			looks: base,
			name: "Audience",
			pose: "idle",
			position: [seat.at[0], seat.row * 0.25 + 0.3, seat.at[1]],
			scale: 0.85,
		});
	}
	return out;
}
