import { describe, expect, test } from "bun:test";

import type { ViewSpec } from "../core/views.ts";
import { createCliTranslator } from "../i18n/translate.ts";
import { hintsFor } from "./DeclarativeView-model.ts";

const FORM = { fields: [], view: "form" } as ViewSpec;
const LIST = { items: [], view: "list-detail" } as ViewSpec;

describe("hintsFor", () => {
	test("renders the English key hints by default", () => {
		const english = createCliTranslator(null, null);
		expect(hintsFor(LIST, true, english)).toBe(
			"· ↑↓ move · 1-9 run · Enter primary · r reload"
		);
		expect(hintsFor(FORM, false, english)).toBe(
			"· ↑↓ field · e edit · space toggle · ←→ option · r reload"
		);
	});

	test("translates the verbs and keeps the key names literal under de", () => {
		const german = createCliTranslator("de", {
			"{key} {action}": "{key}: {action}",
			edit: "bearbeiten",
			option: "Option",
			reload: "neu laden",
			toggle: "umschalten",
			field: "Feld",
		});
		expect(hintsFor(FORM, false, german)).toBe(
			"· ↑↓: Feld · e: bearbeiten · space: umschalten · ←→: Option · r: neu laden"
		);
	});
});
