import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import { ASSERTION_KINDS } from "@/src/lib/prompt-studio.ts";
import { assertionLabel } from "./PromptStudio-assertion-label.ts";

const DE: Record<string, string> = {
	Contains: "Enthält",
	"Valid JSON": "Gültiges JSON",
};

// A German catalog with a marker for keys it lacks, so a raw tag would show.
const de: LiteralMessage = (source) => DE[source] ?? `de:${source}`;

describe("assertionLabel", () => {
	test("every Gateway assertion kind maps to a translated label", () => {
		expect(ASSERTION_KINDS).toHaveLength(35);
		for (const kind of ASSERTION_KINDS) {
			const label = assertionLabel(kind, de);
			expect(label).not.toBe(kind);
			expect(label.length).toBeGreaterThan(0);
		}
		expect(assertionLabel("contains", de)).toBe("Enthält");
		expect(assertionLabel("json_valid", de)).toBe("Gültiges JSON");
		expect(assertionLabel("is_json", de)).toBe("Gültiges JSON");
	});

	test("an unknown kind from a newer Gateway passes through raw", () => {
		expect(assertionLabel("contains_yaml", de)).toBe("contains_yaml");
		expect(assertionLabel("toString", de)).toBe("toString");
	});
});
