import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import type { MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import {
	FIT_RANK,
	fitBlockReason,
	fitRank,
	isBlockedFit,
	isBlockedRepoFit,
	isSlowFit,
	pickBestFit,
} from "./model-fit.ts";

const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

describe("model fit ranking", () => {
	test("orders every verdict with blocked options last", () => {
		const ordered = Object.entries(FIT_RANK)
			.sort(([, a], [, b]) => a - b)
			.map(([fit]) => fit);
		expect(ordered).toEqual([
			"great",
			"ok",
			"partial",
			"cpu",
			"unknown",
			"too_big",
			"no_space",
		]);
		expect(fitRank("something-new")).toBe(FIT_RANK.unknown);
	});

	test("classifies blocked and slow verdicts; unknown never blocks", () => {
		expect(isBlockedFit("too_big")).toBe(true);
		expect(isBlockedFit("no_space")).toBe(true);
		expect(isBlockedFit("unknown")).toBe(false);
		expect(isSlowFit("cpu")).toBe(true);
		expect(isSlowFit("partial")).toBe(true);
		expect(isSlowFit("ok")).toBe(false);
	});

	test("picks the best non-blocked file, then the smaller one", () => {
		const best = pickBestFit([
			{ fit: "no_space", sizeBytes: 1 },
			{ fit: "cpu", sizeBytes: 9 },
			{ fit: "cpu", sizeBytes: 5 },
			{ fit: "too_big", sizeBytes: 2 },
		]);
		expect(best).toEqual({ fit: "cpu", sizeBytes: 5 });
		expect(pickBestFit([])).toBeNull();
	});
});

describe("fitBlockReason", () => {
	test("quotes memory for too_big and free disk for no_space", () => {
		expect(
			fitBlockReason(
				"too_big",
				"",
				{
					ramHuman: "8 GB",
					unifiedMemory: false,
					vramHuman: "4 GB",
				},
				tl
			)
		).toBe(
			"Too large for your device's memory. This device has 8 GB of RAM and 4 GB of GPU memory."
		);
		expect(
			fitBlockReason("no_space", "No room", { diskFreeHuman: "3 GB" }, tl)
		).toBe(
			"Not enough free disk space to download it. Only 3 GB is free on the models drive."
		);
	});

	test("words the verdict itself, never Core's English label", () => {
		const translated: string[] = [];
		const recordingTl: LiteralMessage = (source, values) => {
			translated.push(source);
			return formatMessage(source, values ?? {});
		};
		expect(
			fitBlockReason(
				"too_big",
				"This 20 GB model may not fit.",
				{
					ramHuman: "8 GB",
				},
				recordingTl
			)
		).toBe("Too large for your device's memory. This device has 8 GB of RAM.");
		expect(translated).toContain("Too large for your device's memory");
		expect(fitBlockReason("no_space", "", null, tl)).toBe(
			"Not enough free disk space to download it."
		);
	});

	test("returns null for verdicts that do not block", () => {
		expect(fitBlockReason("cpu", "Runs on your CPU", null, tl)).toBeNull();
		expect(fitBlockReason("unknown", "", null, tl)).toBeNull();
	});
});

const GERMAN_PACK: Record<string, string> = {
	"Not enough free disk space to download it":
		"Nicht genug freier Speicherplatz für den Download",
	"Too large for your device's memory": "Zu groß für den Speicher des Geräts",
	"{verdictLabel}. Only {diskFreeHuman} is free on the models drive.":
		"{verdictLabel}. Auf dem Modelllaufwerk sind nur {diskFreeHuman} frei.",
	"{verdictLabel}. This device has {ramHuman} of RAM and {vramHuman} of GPU memory.":
		"{verdictLabel}. Dieses Gerät hat {ramHuman} RAM und {vramHuman} GPU-Speicher.",
};

const germanTl: LiteralMessage = (source, values) =>
	formatMessage(GERMAN_PACK[source] ?? source, values ?? {}, "de");

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const source = fallback ?? id;
		return formatMessage(GERMAN_PACK[source] ?? source, values, "de");
	},
};

/** Intl puts a no-break space before the unit; compare on plain spaces. */
const plain = (text: string | null) => text?.replace(/\s/gu, " ") ?? null;

describe("fitBlockReason under a German UI", () => {
	afterEach(() => {
		unregisterActiveI18nRuntime(german);
	});

	test("words the device's byte counts with the German decimal mark", () => {
		registerActiveI18nRuntime(german);
		expect(
			plain(
				fitBlockReason(
					"no_space",
					"",
					{ diskFreeBytes: 5_261_334_937, diskFreeHuman: "4.9 GB" },
					germanTl
				)
			)
		).toBe(
			"Nicht genug freier Speicherplatz für den Download. Auf dem Modelllaufwerk sind nur 4,9 GB frei."
		);
		expect(
			plain(
				fitBlockReason(
					"too_big",
					"",
					{
						ramHuman: "15.5 GB",
						totalRamBytes: 16_642_998_272,
						vramBytes: 4 * 1024 ** 3 + 300 * 1024 ** 2,
						vramHuman: "4.3 GB",
					},
					germanTl
				)
			)
		).toBe(
			"Zu groß für den Speicher des Geräts. Dieses Gerät hat 15,5 GB RAM und 4,3 GB GPU-Speicher."
		);
	});

	test("keeps Core's string when a byte count is missing", () => {
		registerActiveI18nRuntime(german);
		expect(
			fitBlockReason("no_space", "", { diskFreeHuman: "3 GB" }, germanTl)
		).toBe(
			"Nicht genug freier Speicherplatz für den Download. Auf dem Modelllaufwerk sind nur 3 GB frei."
		);
	});
});

describe("isBlockedRepoFit", () => {
	test("an older Core's soft too_big (no disk numbers) does not block a snapshot", () => {
		expect(isBlockedRepoFit("too_big", {})).toBe(false);
		expect(isBlockedRepoFit("too_big", undefined)).toBe(false);
	});

	test("a Core that reports free disk, even unknown, blocks too_big and no_space", () => {
		expect(isBlockedRepoFit("too_big", { diskFreeBytes: null })).toBe(true);
		expect(isBlockedRepoFit("too_big", { diskFreeBytes: 10 })).toBe(true);
		expect(isBlockedRepoFit("no_space", {})).toBe(true);
		expect(isBlockedRepoFit("ok", { diskFreeBytes: 10 })).toBe(false);
	});
});
