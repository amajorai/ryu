"use client";

import { useEffect, useState } from "react";
import { whenBrowserIdle } from "../when-browser-idle.ts";
import { hasAcceleratedWebgl, type WebglKind } from "./webgl-gate.ts";

export type BackdropGate = "pending" | "on" | "off";

/**
 * Whether an animated backdrop may mount. `pending` during SSR and hydration;
 * after the first idle period `on` when the browser has a hardware GPU for
 * `kind`, otherwise `off` (the static stage stays). `kind: null` is for 2D
 * canvas backdrops, which only wait for idle. Reduced motion is left to each
 * effect, which draws its own still frame.
 */
export function useBackdropGate(kind: WebglKind | null): BackdropGate {
	const [gate, setGate] = useState<BackdropGate>("pending");
	useEffect(
		() =>
			whenBrowserIdle(() => {
				setGate(kind === null || hasAcceleratedWebgl(kind) ? "on" : "off");
			}),
		[kind]
	);
	return gate;
}
