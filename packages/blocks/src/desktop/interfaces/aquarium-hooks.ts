import { type RefObject, useEffect, useState } from "react";
import {
	EMPTY_THEME,
	readThemeColors,
	type ThemeColors,
} from "./aquarium-palette.ts";

/** Software rasterizers get the lighter budget (less snow, 1x pixels). */
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

/** `null` until checked on the client, then whether the 3D tank can run. */
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
