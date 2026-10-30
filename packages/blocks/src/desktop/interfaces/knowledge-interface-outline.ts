import { type RefObject, useLayoutEffect, useState } from "react";
import type {
	ForceSettings,
	KnowledgeSettings,
	Layout,
} from "./knowledge-model.ts";
import { cssColor, type KnowledgePalette } from "./knowledge-palette.ts";
import type { SkeletonOutline } from "./knowledge-parts.tsx";
import {
	chromeObstacles,
	createProjection,
	type GraphStyles,
	openingPose,
	projectPose,
	syncLabels,
} from "./knowledge-stage.ts";

/**
 * The loading outline is the layout projected through the pose the 3D
 * view opens with, measured before the first paint (labels included,
 * since the fit leaves room for them), so nodes fade in exactly where
 * their outline sat.
 */
export function useKnowledgeOutline({
	flat,
	forcesRef,
	hasGraph,
	insetRight,
	labels,
	layout,
	palette,
	sceneReady,
	settings,
	stageRef,
	stageSectionRef,
	stageSize,
	styles,
}: {
	flat: boolean;
	forcesRef: { readonly current: ForceSettings };
	hasGraph: boolean;
	insetRight: number;
	labels: { readonly current: Map<string, HTMLElement> };
	layout: Layout;
	palette: KnowledgePalette;
	sceneReady: boolean;
	settings: KnowledgeSettings;
	stageRef: RefObject<HTMLDivElement | null>;
	stageSectionRef: RefObject<HTMLElement | null>;
	stageSize: { height: number; width: number } | null;
	styles: GraphStyles;
}) {
	const [outline, setOutline] = useState<SkeletonOutline | null>(null);
	const needsOutline = hasGraph && !flat && !sceneReady;
	useLayoutEffect(() => {
		if (!(needsOutline && stageSize)) {
			return;
		}
		const stage = { ...stageSize, insetRight };
		const pose = openingPose(
			layout,
			stage,
			labels.current,
			forcesRef.current.linkDistance
		);
		const pairs: [number, number][] = [];
		for (let link = 0; link < layout.links.length / 2; link += 1) {
			pairs.push([
				layout.links[link * 2] ?? 0,
				layout.links[link * 2 + 1] ?? 0,
			]);
		}
		const nodes = projectPose(layout, pose, stageSize, settings.nodeSize);
		const count = layout.ids.length;
		const paint = {
			agents: layout.ids.map((_, index) => (styles.agent[index] ?? 0) > 0),
			background: cssColor(palette.background),
			link: cssColor(palette.link, palette.linkAlpha),
			nodes: layout.ids.map((_, index) =>
				cssColor(
					[
						Math.round((styles.colors[index * 3] ?? 0) * 255),
						Math.round((styles.colors[index * 3 + 1] ?? 0) * 255),
						Math.round((styles.colors[index * 3 + 2] ?? 0) * 255),
					],
					styles.alpha[index] ?? 1
				)
			),
		};
		// Labels take their places for the preview too, from the same
		// projection, so the first frame reads in full before WebGL is up.
		const preview = createProjection(count);
		for (const [index, [x, y, radius]] of nodes.entries()) {
			preview.x[index] = x;
			preview.y[index] = y;
			preview.radius[index] = radius;
			preview.visible[index] = 1;
		}
		syncLabels(layout, preview, styles, styles.alpha, labels.current, {
			height: stageSize.height,
			obstacles: chromeObstacles(stageRef.current, [
				...(stageSectionRef.current?.querySelectorAll<HTMLElement>(
					"[data-knowledge-chrome]"
				) ?? []),
			]),
			textFade: settings.textFade,
			width: stageSize.width,
		});
		setOutline({
			height: stageSize.height,
			links: pairs,
			nodes,
			paint,
			width: stageSize.width,
		});
	}, [
		needsOutline,
		layout,
		stageSize,
		insetRight,
		settings.nodeSize,
		settings.textFade,
		styles,
		palette,
	]);
	return { needsOutline, outline };
}
