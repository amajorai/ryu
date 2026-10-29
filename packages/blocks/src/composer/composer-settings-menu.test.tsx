import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerSettingsMenu } from "./composer-settings-menu.tsx";

describe("ComposerSettingsMenu tone", () => {
	test("foreground tone preserves the existing Island trigger styling", () => {
		const sections = [
			{
				key: "model",
				label: "Model",
				ariaLabel: "Model",
				value: "model",
				items: [{ id: "model", name: "Model" }],
				onChange: () => {},
			},
		];
		const previous = renderToStaticMarkup(
			createElement(ComposerSettingsMenu, {
				sections,
				className: "text-foreground hover:bg-muted",
			})
		);
		const semantic = renderToStaticMarkup(
			createElement(ComposerSettingsMenu, { sections, tone: "foreground" })
		);
		expect(semantic).toBe(previous);
		expect(semantic).not.toContain("tone=");
	});
});
