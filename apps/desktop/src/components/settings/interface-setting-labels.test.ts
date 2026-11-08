import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { interfaceSettingsFor } from "@ryuhq/protocol/interfaces";
import {
	interfaceSettingLabel,
	withDisplayLabel,
} from "./interface-setting-labels.ts";

const GERMAN: Record<string, string> = {
	Cover: "Füllen",
	"Cover color": "Umschlagfarbe",
};

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values);
const german: LiteralMessage = (source, values) =>
	formatMessage(GERMAN[source] ?? source, values);

const PASSPORT = { renderer: "passport" } as const;

describe("interfaceSettingLabel", () => {
	test("the passport cover setting reads as a cover colour, not image fit", () => {
		const cover = { key: "cover", label: "Cover" };
		expect(interfaceSettingLabel(PASSPORT, cover, english)).toBe("Cover color");
		expect(interfaceSettingLabel(PASSPORT, cover, german)).toBe(
			"Umschlagfarbe"
		);
	});

	test("other fields, renderers and declared settings keep their label", () => {
		const cover = { key: "cover", label: "Cover" };
		expect(
			interfaceSettingLabel(PASSPORT, { key: "ink", label: "Ink" }, german)
		).toBe("Ink");
		expect(interfaceSettingLabel({ renderer: "journal" }, cover, german)).toBe(
			"Cover"
		);
		const declared = { renderer: "passport" as const, settings: [] };
		expect(interfaceSettingLabel(declared, cover, german)).toBe("Cover");
	});

	test("the shipped passport schema gets the override on its cover field", () => {
		const fields = interfaceSettingsFor(PASSPORT).map((field) =>
			withDisplayLabel(PASSPORT, field, german)
		);
		const cover = fields.find((field) => field.key === "cover");
		expect(cover?.label).toBe("Umschlagfarbe");
		expect(cover?.options?.map((option) => option.value)).toEqual([
			"navy",
			"burgundy",
			"green",
			"black",
		]);
		const others = fields.filter((field) => field.key !== "cover");
		expect(others).toEqual(
			interfaceSettingsFor(PASSPORT).filter((field) => field.key !== "cover")
		);
	});
});
