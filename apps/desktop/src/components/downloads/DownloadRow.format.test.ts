// The download row's ETA, speed and state words: English output reads as the
// hand-built strings did, and other locales get their own units and digits.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, describe, expect, it } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { DownloadTask } from "@/src/lib/api/downloads.ts";
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";

const { formatEta, formatRate, stateLabel } = await import("./DownloadRow.tsx");

function runtimeFor(locale: string, direction: "ltr" | "rtl" = "ltr") {
	return {
		direction,
		locale,
		translate(id: string, values?: MessageValuesInput, fallback?: string) {
			return formatMessage(fallback ?? id, values, locale);
		},
	};
}

function active(remainingSeconds: number): DownloadTask {
	const speed = 1_048_576;
	return {
		id: "a",
		state: "active",
		created_at: 1,
		updated_at: 1,
		dest_path: null,
		error: null,
		kind: "model",
		label: "a",
		received_bytes: 0,
		retryable: true,
		speed_bps: speed,
		total_bytes: remainingSeconds * speed,
		url: null,
	};
}

const english = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values, "en");

let registered: ReturnType<typeof runtimeFor> | null = null;
afterEach(() => {
	if (registered) {
		unregisterActiveI18nRuntime(registered);
		registered = null;
	}
});

describe("download row formatting", () => {
	it("keeps the English ETA and speed", () => {
		expect(formatEta(active(42), "en")).toBe("42s left");
		expect(formatEta(active(300), "en")).toBe("5m left");
		expect(formatEta(active(5400), "en")).toBe("1.5h left");
		expect(formatRate(12 * 1_048_576, "en")).toBe("12 MB/s");
		expect(stateLabel({ ...active(300), state: "paused" }, english)).toBe(
			"Paused"
		);
	});

	it("uses German units and a decimal comma under de", () => {
		registered = runtimeFor("de");
		registerActiveI18nRuntime(registered);
		const eta = formatEta(active(5400), "de") ?? "";
		expect(eta).toContain("1,5");
		expect(eta).not.toContain("1.5h");
		expect(formatEta(active(300), "de")).not.toContain("5m");
		expect(formatRate(1_572_864, "de")).toContain("1,5");
	});

	it("uses Arabic units under ar", () => {
		registered = runtimeFor("ar", "rtl");
		registerActiveI18nRuntime(registered);
		const eta = formatEta(active(42), "ar") ?? "";
		expect(eta).not.toContain("42s");
		expect(eta).toContain(
			new Intl.NumberFormat("ar", {
				style: "unit",
				unit: "second",
				unitDisplay: "short",
			}).format(42)
		);
	});

	it("has no ETA without a size or a speed", () => {
		expect(formatEta({ ...active(10), speed_bps: null })).toBeNull();
		expect(formatEta({ ...active(10), total_bytes: null })).toBeNull();
	});
});
