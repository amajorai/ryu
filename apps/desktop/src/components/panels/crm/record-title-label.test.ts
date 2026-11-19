import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { localizedRecordTitle } from "./record-title-label.ts";

const JA: Record<string, string> = {
	"Untitled company": "無題の会社",
	"Untitled deal": "無題の商談",
	"Untitled person": "無題の人物",
	"Untitled {object}": "無題の{object}",
};
function tlJa(source: string, values?: MessageValuesInput): string {
	return formatMessage(JA[source] ?? source, values ?? {}, "ja");
}

describe("localizedRecordTitle", () => {
	test("a seed object's placeholder reads as a whole translated sentence", () => {
		expect(localizedRecordTitle("Untitled company", {}, tlJa)).toBe(
			"無題の会社"
		);
		expect(localizedRecordTitle("Untitled deal", undefined, tlJa)).toBe(
			"無題の商談"
		);
		expect(localizedRecordTitle("Untitled person", {}, tlJa)).toBe(
			"無題の人物"
		);
	});

	test("a custom object's placeholder keeps the user's object name", () => {
		expect(localizedRecordTitle("Untitled investor", {}, tlJa)).toBe(
			"無題のinvestor"
		);
	});

	test("a title the user typed is kept as typed", () => {
		expect(localizedRecordTitle("Acme", { name: "Acme" }, tlJa)).toBe("Acme");
		expect(
			localizedRecordTitle(
				"Untitled company",
				{ name: "Untitled company" },
				tlJa
			)
		).toBe("Untitled company");
		expect(
			localizedRecordTitle("Untitled album", { album: "Untitled album" }, tlJa)
		).toBe("Untitled album");
	});

	test("the recognized placeholder is the backend's record title", async () => {
		const validation = await Bun.file(
			`${import.meta.dir}/../../../../../../apps-store/crm/backend/src/store/validation.rs`
		).text();
		expect(validation).toContain(
			'format!("Untitled {}", object.singular.to_lowercase())'
		);
	});
});
