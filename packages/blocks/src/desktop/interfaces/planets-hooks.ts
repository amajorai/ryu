import { type RefObject, useEffect, useState } from "react";
import { type Box, EMPTY_HUD, type HudLayout } from "./planets-model.ts";
import {
	EMPTY_THEME,
	readThemeColors,
	type ThemeColors,
} from "./planets-palette.ts";

/** Software rasterizers get the lighter budget (fewer stars, 1x pixels). */
const SOFTWARE_RENDERER =
	/swiftshader|llvmpipe|software|softpipe|mesa offscreen/i;

export interface WebGLSupport {
	quality: "high" | "low";
	supported: boolean;
}

function probeWebGL(): WebGLSupport {
	try {
		const canvas = document.createElement("canvas");
		const gl = (canvas.getContext("webgl2") ??
			canvas.getContext("webgl")) as WebGLRenderingContext | null;
		if (!gl) {
			return { quality: "low", supported: false };
		}
		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		const renderer = String(
			gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
		);
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return {
			quality: SOFTWARE_RENDERER.test(renderer) ? "low" : "high",
			supported: true,
		};
	} catch {
		return { quality: "low", supported: false };
	}
}

/** `null` until checked on the client, then whether the 3D scene can run. */
export function useWebGLSupport(): WebGLSupport | null {
	const [support, setSupport] = useState<WebGLSupport | null>(null);
	useEffect(() => {
		setSupport(probeWebGL());
	}, []);
	return support;
}

/**
 * The theme colors at `ref`, re-read whenever the document's class or inline
 * variables change (theme switches rewrite one or the other).
 */
export function useThemeColors(
	ref: RefObject<HTMLElement | null>
): ThemeColors {
	const [colors, setColors] = useState<ThemeColors>(EMPTY_THEME);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => {
			const next = readThemeColors(element);
			setColors((previous) =>
				JSON.stringify(previous) === JSON.stringify(next) ? previous : next
			);
		};
		update();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(update);
		const options = {
			attributeFilter: ["class", "style", "data-theme"],
			attributes: true,
		};
		observer.observe(element.ownerDocument.documentElement, options);
		if (element.ownerDocument.body) {
			observer.observe(element.ownerDocument.body, options);
		}
		return () => observer.disconnect();
	}, [ref]);
	return colors;
}

const HUD_PARTS = ["card", "controls", "legend"] as const;

function measureHud(scene: HTMLElement): HudLayout {
	const origin = scene.getBoundingClientRect();
	const boxOf = (part: (typeof HUD_PARTS)[number]): Box | null => {
		const element = scene.querySelector<HTMLElement>(
			`[data-planets-hud="${part}"]`
		);
		const rect = element?.getBoundingClientRect();
		if (!rect || rect.width <= 0 || rect.height <= 0) {
			return null;
		}
		return {
			bottom: Math.round(rect.bottom - origin.top),
			left: Math.round(rect.left - origin.left),
			right: Math.round(rect.right - origin.left),
			top: Math.round(rect.top - origin.top),
		};
	};
	return {
		card: boxOf("card"),
		controls: boxOf("controls"),
		legend: boxOf("legend"),
	};
}

/**
 * Where the HUD's floating pieces (`data-planets-hud`) sit inside the scene,
 * kept current as the scene or any piece resizes (a panel opens, the system
 * card folds or unfolds). `watch` re-scans when pieces mount or unmount.
 */
export function useHudLayout(
	sceneRef: RefObject<HTMLElement | null>,
	watch: string
): HudLayout {
	const [layout, setLayout] = useState<HudLayout>(EMPTY_HUD);
	useEffect(() => {
		const scene = sceneRef.current;
		if (!(scene && watch !== "")) {
			return;
		}
		const update = () => {
			const next = measureHud(scene);
			setLayout((previous) =>
				JSON.stringify(previous) === JSON.stringify(next) ? previous : next
			);
		};
		update();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(update);
		observer.observe(scene);
		for (const element of scene.querySelectorAll("[data-planets-hud]")) {
			observer.observe(element);
		}
		return () => observer.disconnect();
	}, [sceneRef, watch]);
	return layout;
}

export interface ElementSize {
	height: number;
	width: number;
}

const NO_SIZE: ElementSize = { height: 0, width: 0 };

/** An element's rendered size, kept current as it resizes (0 until measured). */
export function useElementSize(
	ref: RefObject<HTMLElement | null>
): ElementSize {
	const [size, setSize] = useState<ElementSize>(NO_SIZE);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => {
			const rect = element.getBoundingClientRect();
			const width = Math.round(rect.width);
			const height = Math.round(rect.height);
			setSize((previous) =>
				previous.width === width && previous.height === height
					? previous
					: { height, width }
			);
		};
		update();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}
