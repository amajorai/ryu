import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type AppSurface,
	AppSurfaceProvider,
	NativeDesktopOnly,
} from "./app-surface-context.tsx";

const BROWSER_SURFACES: readonly AppSurface[] = [
	"web",
	"extension",
	"mobile",
	"telegram",
];

function renderActions(surface: AppSurface): string {
	const children = [
		createElement("button", { key: "tab", type: "button" }, "Open in new tab"),
		createElement(
			NativeDesktopOnly,
			{ key: "window" },
			createElement("button", { type: "button" }, "Open in new window")
		),
	];

	return renderToStaticMarkup(
		createElement(AppSurfaceProvider, { surface }, children)
	);
}

describe("AppSurfaceProvider", () => {
	test("keeps native desktop actions on desktop", () => {
		const markup = renderActions("desktop");

		expect(markup).toContain("Open in new tab");
		expect(markup).toContain("Open in new window");
	});

	for (const surface of BROWSER_SURFACES) {
		test(`removes native desktop actions from ${surface}`, () => {
			const markup = renderActions(surface);

			expect(markup).toContain("Open in new tab");
			expect(markup).not.toContain("Open in new window");
		});
	}
});
