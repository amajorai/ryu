import { describe, expect, test } from "bun:test";
import { normalizeVaultSecret } from "@/src/lib/api/vault.ts";
import {
	buildFolderTree,
	callerSubject,
	exportFileName,
	fromDateTimeLocal,
	guessImportFormat,
	inFolder,
	normalizeFolder,
	parseTags,
	rotationDaysText,
	rotationSecsFromDays,
	toDateTimeLocal,
	withSharedFallback,
} from "./vault-view.ts";

describe("folders", () => {
	test("normalizes paths", () => {
		expect(normalizeFolder("")).toBe("/");
		expect(normalizeFolder("a//b/")).toBe("/a/b");
	});

	test("builds a sorted tree with ancestors", () => {
		expect(buildFolderTree(["/b/c", "/a", "/"])).toEqual([
			{ path: "/", depth: 0, label: "All folders" },
			{ path: "/a", depth: 1, label: "a" },
			{ path: "/b", depth: 1, label: "b" },
			{ path: "/b/c", depth: 2, label: "c" },
		]);
	});

	test("matches a folder and its sub-folders only", () => {
		expect(inFolder("/a/b", "/")).toBe(true);
		expect(inFolder("/a/b", "/a")).toBe(true);
		expect(inFolder("/ab", "/a")).toBe(false);
		expect(inFolder("/", "/a")).toBe(false);
	});
});

describe("form conversions", () => {
	test("round-trips datetime-local values", () => {
		expect(toDateTimeLocal(null)).toBe("");
		expect(fromDateTimeLocal("")).toBeNull();
		const iso = fromDateTimeLocal("2026-10-05T14:30");
		expect(iso).not.toBeNull();
		expect(toDateTimeLocal(iso)).toBe("2026-10-05T14:30");
	});

	test("parses tags", () => {
		expect(parseTags(" ci, payments ci\nops ")).toEqual([
			"ci",
			"payments",
			"ops",
		]);
	});

	test("converts rotation days", () => {
		expect(rotationDaysText(null)).toBe("");
		expect(rotationDaysText(86_400 * 30)).toBe("30");
		expect(rotationSecsFromDays("")).toBeNull();
		expect(rotationSecsFromDays("1")).toBe(86_400);
		expect(rotationSecsFromDays("0.001")).toBe(300);
		expect(() => rotationSecsFromDays("-1")).toThrow();
	});
});

test("callerSubject matches Core's change-request subjects", () => {
	expect(callerSubject(undefined)).toBe("operator");
});

test("export file names and import format guesses", () => {
	expect(exportFileName("k8s-secret", "prod")).toBe("vault-prod.yaml");
	expect(guessImportFormat("x.json", "")).toBe("json");
	expect(guessImportFormat(".env", '{"A":"1"}')).toBe("json");
	expect(guessImportFormat(".env", "A=1")).toBe("dotenv");
});

test("shared rows without capabilities fall back for managers only", () => {
	const shared = normalizeVaultSecret({ name: "X", source: "control-plane" });
	expect(withSharedFallback(shared, false).capabilities).toEqual([]);
	expect(withSharedFallback(shared, true).capabilities).toContain("delete");
	const local = normalizeVaultSecret({ name: "Y" });
	expect(withSharedFallback(local, true).capabilities).toEqual([]);
});
