import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type {
	InterfaceAgent,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import type { JobRow } from "./jobs-model-core.ts";
import { jobTimeline } from "./jobs-model-detail.ts";

// The posting step names who was hired in the reader's list pattern, not an
// English comma glued onto a translated "and".
function stubRuntime(locale: string, pack: Record<string, string>) {
	return {
		direction: "ltr" as const,
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			return formatMessage(
				pack[fallback ?? id] ?? fallback ?? id,
				values,
				locale
			);
		},
	};
}

const japanese = stubRuntime("ja", { "Hired {names}": "{names}を採用" });
const german = stubRuntime("de", { "Hired {names}": "Eingestellt: {names}" });

afterEach(() => {
	unregisterActiveI18nRuntime(japanese);
	unregisterActiveI18nRuntime(german);
});

function row(names: readonly string[]): JobRow {
	const agents = names.map(
		(name) =>
			({ id: name.toLowerCase(), name, status: "idle" }) as InterfaceAgent
	);
	return {
		agents,
		company: { id: "personal", kind: "personal", name: "" },
		deliverable: null,
		freelancer: agents[0],
		status: "in-progress",
		thread: {
			messageCount: 1,
			updatedAt: "2026-11-01T10:00:00Z",
		} as InterfaceThread,
		title: "Logo",
	} as unknown as JobRow;
}

function hiredDetail(names: readonly string[]): string | null {
	return jobTimeline(row(names))[0]?.detail ?? null;
}

test("lists hired freelancers with the Japanese list pattern", () => {
	registerActiveI18nRuntime(japanese);
	expect(hiredDetail(["Atlas", "Brook", "Cipher"])).toBe(
		"Atlas、Brook、Cipherを採用"
	);
});

test("lists hired freelancers with the German conjunction", () => {
	registerActiveI18nRuntime(german);
	expect(hiredDetail(["Atlas", "Brook", "Cipher"])).toBe(
		"Eingestellt: Atlas, Brook und Cipher"
	);
});

test("names one hire in English and lists several the English way", () => {
	expect(hiredDetail(["Grace"])).toBe("Hired Grace");
	expect(hiredDetail(["Atlas", "Brook", "Cipher"])).toBe(
		`Hired ${new Intl.ListFormat("en", { type: "conjunction" }).format([
			"Atlas",
			"Brook",
			"Cipher",
		])}`
	);
	expect(hiredDetail([])).toBe("No freelancer hired");
});
