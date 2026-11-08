import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import {
	spaceDisplayDescription,
	spaceDisplayName,
	spaceSelectOptions,
	withSpaceDisplayLabels,
} from "./system-space-label.ts";

const japanese: Record<string, string> = {
	Artifacts: "成果物",
	"Files created by Ryu and agents": "Ryu とエージェントが作成したファイル",
	"Files you upload in chat and pages":
		"チャットとページでアップロードしたファイル",
	Uploads: "アップロード",
};
const ja: LiteralMessage = (source) => japanese[source] ?? source;

describe("spaceDisplayName", () => {
	test("localizes a system Space that still has its seed name", () => {
		expect(spaceDisplayName({ name: "Uploads", system: true }, ja)).toBe(
			"アップロード"
		);
		expect(spaceDisplayName({ name: "Artifacts", system: true }, ja)).toBe(
			"成果物"
		);
	});

	test("shows a renamed system Space as written", () => {
		expect(spaceDisplayName({ name: "My uploads", system: true }, ja)).toBe(
			"My uploads"
		);
		expect(spaceDisplayName({ name: "uploads", system: true }, ja)).toBe(
			"uploads"
		);
	});

	test("leaves an ordinary Space that happens to share a seed name alone", () => {
		expect(spaceDisplayName({ name: "Uploads", system: false }, ja)).toBe(
			"Uploads"
		);
		expect(spaceDisplayName({ name: "Uploads" }, ja)).toBe("Uploads");
	});
});

describe("spaceDisplayDescription", () => {
	test("localizes the seed descriptions of a system Space", () => {
		expect(
			spaceDisplayDescription(
				{
					description: "Files you upload in chat and pages",
					name: "Uploads",
					system: true,
				},
				ja
			)
		).toBe("チャットとページでアップロードしたファイル");
	});

	test("keeps custom, missing and non-system descriptions", () => {
		expect(
			spaceDisplayDescription(
				{ description: "Team drops", name: "Uploads", system: true },
				ja
			)
		).toBe("Team drops");
		expect(spaceDisplayDescription({ name: "Uploads", system: true }, ja)).toBe(
			null
		);
		expect(
			spaceDisplayDescription(
				{
					description: "Files created by Ryu and agents",
					name: "Mine",
					system: false,
				},
				ja
			)
		).toBe("Files created by Ryu and agents");
	});
});

describe("withSpaceDisplayLabels", () => {
	test("returns a localized copy and keeps other fields", () => {
		const space = {
			description: "Files created by Ryu and agents",
			id: "s1",
			name: "Artifacts",
			system: true,
		};
		const shown = withSpaceDisplayLabels(space, ja);
		expect(shown).toEqual({
			description: "Ryu とエージェントが作成したファイル",
			id: "s1",
			name: "成果物",
			system: true,
		});
		expect(space.name).toBe("Artifacts");
	});

	test("returns the same object when nothing is localized", () => {
		const space = { id: "s2", name: "Research", system: false };
		expect(withSpaceDisplayLabels(space, ja)).toBe(space);
	});
});

describe("spaceSelectOptions", () => {
	test("labels seeded system Spaces in the viewer's language", () => {
		expect(
			spaceSelectOptions(
				[
					{ id: "a", name: "Uploads", system: true },
					{ id: "b", name: "Notes", system: false },
				],
				ja
			)
		).toEqual([
			{ label: "アップロード", value: "a" },
			{ label: "Notes", value: "b" },
		]);
	});
});
