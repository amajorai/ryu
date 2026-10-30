import type { WorldLayout } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { canPaint2d } from "./world-2d-interface-camera.ts";
import type { SceneFrame, villageProps } from "./world-2d-layout.ts";
import type { PIXEL_SCENES } from "./world-2d-palette.ts";
import {
	buildGroundLayer,
	buildStaticScene,
	type SceneInput,
} from "./world-2d-render.ts";
import type { villageRoofColors, WORLD_PALETTES } from "./world-themes.ts";
import type { layoutVillage } from "./world-village.ts";

/** The village's baked pixel scene (null where no 2D canvas can paint it). */
export function useWorld2dScene({
	frame,
	furniture,
	layout,
	palette,
	pixel,
	roofs,
	title,
	village,
}: {
	frame: SceneFrame;
	furniture: ReturnType<typeof villageProps>;
	layout: WorldLayout;
	palette: (typeof WORLD_PALETTES)[keyof typeof WORLD_PALETTES];
	pixel: (typeof PIXEL_SCENES)[keyof typeof PIXEL_SCENES];
	roofs: ReturnType<typeof villageRoofColors>;
	title: string;
	village: ReturnType<typeof layoutVillage>;
}) {
	const agentsWorking = useMemo(() => {
		const map = new Map<string, boolean>();
		for (const entity of layout.entities) {
			map.set(entity.agentId, entity.status === "working");
		}
		return map;
	}, [layout]);
	const sceneInput: SceneInput = useMemo(
		() => ({
			agentsWorking,
			frame,
			layout,
			props: furniture,
			roofs,
			scene: pixel,
			sceneTones: palette.scene,
			title,
			village,
		}),
		[
			agentsWorking,
			frame,
			furniture,
			layout,
			palette,
			pixel,
			roofs,
			title,
			village,
		]
	);
	const canDraw = canPaint2d();
	const ground = useMemo(
		() => (canDraw ? buildGroundLayer(sceneInput) : null),
		// The ground ignores statuses: rebuild only when the place changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[canDraw, frame, furniture, layout, pixel, village]
	);
	const staticScene = useMemo(
		() => (ground ? buildStaticScene(sceneInput, ground) : null),
		[ground, sceneInput]
	);
	return staticScene;
}
