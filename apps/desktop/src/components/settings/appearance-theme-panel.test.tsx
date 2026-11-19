import { expect, test } from "bun:test";
import { themePanelHeading } from "./appearance-theme-panel.tsx";

const tl = (source: string) => `[${source}]`;

test("each colour-theme panel heading is a whole translated sentence per mode", () => {
	expect(themePanelHeading("light", tl)).toEqual({
		description: "[Used when light mode is active.]",
		title: "[Light theme]",
	});
	expect(themePanelHeading("dark", tl)).toEqual({
		description: "[Used when dark mode is active.]",
		title: "[Dark theme]",
	});
});
