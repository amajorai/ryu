import { describe, expect, test } from "bun:test";

import {
	SYSTEM_VERSION_LABELS,
	systemVersionLabel,
	versionLabelText,
} from "./system-version-labels.ts";

/** A stand-in Japanese catalog: every system label gets a distinct entry. */
const JA: Record<string, string> = Object.fromEntries(
	SYSTEM_VERSION_LABELS.map((label, index) => [label, `ja-${index}`])
);
JA["Release v2"] = "リリース v2";

const ja = (source: string): string => JA[source] ?? source;

describe("system version labels", () => {
	test("each system label resolves through the translator", () => {
		for (const [index, label] of SYSTEM_VERSION_LABELS.entries()) {
			expect(versionLabelText(label, ja)).toBe(`ja-${index}`);
			expect(systemVersionLabel(label, ja)).toBe(`ja-${index}`);
		}
	});

	test("the switch covers exactly the listed labels", () => {
		const seen: string[] = [];
		for (const label of SYSTEM_VERSION_LABELS) {
			systemVersionLabel(label, (source) => {
				seen.push(source);
				return source;
			});
		}
		expect(seen).toEqual([...SYSTEM_VERSION_LABELS]);
		expect(new Set(SYSTEM_VERSION_LABELS).size).toBe(
			SYSTEM_VERSION_LABELS.length
		);
	});

	test("a user label passes through unchanged, even when the catalog has it", () => {
		expect(versionLabelText("Release v2", ja)).toBe("Release v2");
		expect(systemVersionLabel("Release v2", ja)).toBeNull();
	});

	test("matching is exact", () => {
		expect(versionLabelText("workflow saved", ja)).toBe("workflow saved");
		expect(versionLabelText("Workflow saved ", ja)).toBe("Workflow saved ");
	});
});
