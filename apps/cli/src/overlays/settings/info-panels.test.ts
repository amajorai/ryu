import { describe, expect, test } from "bun:test";
import { createCliTranslator } from "../../i18n/translate.ts";
import { fallbackPanelMeta } from "./info-panels.tsx";

describe("settings fallback panel", () => {
	test("its description is one translated sentence with a translated label", () => {
		const german = createCliTranslator("de", {
			"{label} settings.": "Einstellungen für {label}.",
			Updates: "Aktualisierungen",
		});
		expect(fallbackPanelMeta("Updates", german).description).toBe(
			"Einstellungen für Aktualisierungen."
		);
	});
});
