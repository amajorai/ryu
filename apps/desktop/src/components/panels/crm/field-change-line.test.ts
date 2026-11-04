import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { Field } from "@/src/lib/api/crm.ts";
import { fieldChangeLine } from "./field-change-line.ts";
import { formatValue } from "./fields.tsx";

const DE: Record<string, string> = {
	"A field": "Ein Feld",
	No: "Nein",
	Yes: "Ja",
	"{field} changed": "{field} geändert",
	"{field} changed from {from}": "{field} von {from} geändert",
	"{field} changed from {from} to {to}": "{field} von {from} in {to} geändert",
	"{field} changed to {to}": "{field} in {to} geändert",
};

function tlDe(source: string, values?: MessageValuesInput): string {
	return formatMessage(DE[source] ?? source, values, "de");
}

function field(overrides: Partial<Field> = {}): Field {
	return {
		created_at: "2026-01-01T00:00:00Z",
		field_type: "checkbox",
		id: "f1",
		is_required: false,
		is_system: false,
		is_unique: false,
		name: "Aktiv",
		object_id: "o1",
		position: 0,
		slug: "aktiv",
		updated_at: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("fieldChangeLine", () => {
	test("a checkbox from/to change is one whole translated sentence in de", () => {
		expect(
			fieldChangeLine(tlDe, { from_value: false, to_value: true }, field())
		).toBe("Aktiv von Nein in Ja geändert");
	});

	test("each one-sided change picks its own whole message", () => {
		expect(fieldChangeLine(tlDe, { to_value: true }, field())).toBe(
			"Aktiv in Ja geändert"
		);
		expect(fieldChangeLine(tlDe, { from_value: true }, field())).toBe(
			"Aktiv von Ja geändert"
		);
		expect(fieldChangeLine(tlDe, {}, field())).toBe("Aktiv geändert");
	});

	test("an unknown field names no values", () => {
		expect(
			fieldChangeLine(tlDe, { from_value: false, to_value: true }, undefined)
		).toBe("Ein Feld geändert");
	});
});

describe("formatValue", () => {
	test("multi-select labels join as a list in the reader's language", () => {
		const tags = field({
			config: {
				options: [
					{ id: "a", label: "Alpha", position: 0 },
					{ id: "b", label: "Beta", position: 1 },
					{ id: "c", label: "Gamma", position: 2 },
				],
			},
			field_type: "multi_select",
		});
		expect(formatValue(tags, ["a", "b", "c"])).toBe("Alpha, Beta, and Gamma");
	});

	test("a percent value uses the locale's percent format, decimals kept", () => {
		expect(formatValue(field({ field_type: "percent" }), 12.5)).toBe("12.5%");
	});
});
