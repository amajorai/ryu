import { describe, expect, test } from "bun:test";
import { BUILTIN_INTERFACES } from "./registry.ts";
import { isChatTabPath, resolveSurfaceRenderer } from "./surface-renderer.ts";

function builtin(label: string) {
	const found = BUILTIN_INTERFACES.find((entry) => entry.label === label);
	if (!found) {
		throw new Error(`missing built-in ${label}`);
	}
	return found;
}

/** World 2D's defaults: its theme, the 3D kit's settings, and the controls hint. */
const WORLD_2D_DEFAULTS = {
	controls: "auto",
	overlayDensity: "full",
	theme: "meadow",
	workBubbles: true,
} as const;

describe("resolveSurfaceRenderer", () => {
	test("resolves each surface renderer with default params", () => {
		expect(resolveSurfaceRenderer(builtin("Channels"))).toEqual({
			params: { groupBy: "agent" },
			renderer: "channels",
		});
		expect(resolveSurfaceRenderer(builtin("Feed"))).toEqual({
			params: { order: "recent" },
			renderer: "feed",
		});
		// The worlds carry the kit's shared settings (overlay density, work
		// bubbles) as well as their own.
		expect(resolveSurfaceRenderer(builtin("World 2D"))).toEqual({
			params: WORLD_2D_DEFAULTS,
			renderer: "world-2d",
		});
		expect(resolveSurfaceRenderer(builtin("World 3D"))).toEqual({
			params: {
				camera: "orbit",
				minimap: true,
				overlayDensity: "full",
				theme: "meadow",
				workBubbles: true,
			},
			renderer: "world-3d",
		});
	});

	test("degrades invalid Marketplace params to defaults", () => {
		expect(
			resolveSurfaceRenderer({
				...builtin("World 2D"),
				id: "@example/towns:pixel",
				origin: "marketplace",
				params: { theme: "lava", unknown: true },
				plugin: "@example/towns",
			})
		).toEqual({ params: WORLD_2D_DEFAULTS, renderer: "world-2d" });
	});

	test("never renders a whole shell as a surface", () => {
		for (const label of ["Bot", "OS", "Agent"]) {
			expect(resolveSurfaceRenderer(builtin(label))).toEqual({
				renderer: "unsupported",
			});
		}
	});
});

test("isChatTabPath matches the chat route only", () => {
	expect(isChatTabPath("/chat")).toBe(true);
	expect(isChatTabPath("/chat/abc")).toBe(true);
	expect(isChatTabPath("/chats")).toBe(false);
	expect(isChatTabPath("/settings")).toBe(false);
});
