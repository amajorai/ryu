// The desktop byte formatters moved onto the shared `formatByteSize`: English
// output must read exactly as the hand-built strings did, and other locales
// get their own separators.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, describe, expect, it } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";

const { formatBytes: downloadBytes } = await import(
	"@/src/components/downloads/DownloadRow.tsx"
);
const { formatBytes: uploadLimitBytes } = await import(
	"@/src/lib/api/spaces-upload-limits.ts"
);
const { formatBytes: importBytes } = await import(
	"@/src/components/spaces/space-imports/model.ts"
);
const { bytes: backupBytes } = await import(
	"@/src/components/settings/BackupSettings-shared.ts"
);
const { formatSpeed } = await import("@/src/live/adapters/downloads.ts");

// The previous hand-built implementations, kept as the English reference.
function legacyDownload(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	const units = ["KB", "MB", "GB", "TB"];
	let value = n / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
function legacyUploadLimit(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		value >= 10 || Number.isInteger(value) ? Math.round(value) : value;
	return `${Number(rounded.toFixed(1))} ${units[unit]}`;
}
function legacyImport(bytes: number): string {
	if (bytes <= 0) {
		return "";
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function legacyBackup(value: number): string {
	return value < 1024 * 1024
		? `${(value / 1024).toFixed(1)} KB`
		: `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function legacySpeed(bps: number): string {
	if (bps >= 1_048_576) {
		return `${(bps / 1_048_576).toFixed(1)} MB/s`;
	}
	return `${Math.round(bps / 1024)} KB/s`;
}

const SAMPLES = [
	0, 1, 5, 512, 999, 1023, 1024, 1536, 10_240, 10_700, 524_288, 1_048_575,
	1_048_576, 1_572_864, 33_554_432, 209_715_200, 1_073_741_824, 5_046_586_573,
	1_099_511_627_776, 2_251_799_813_685_248,
];

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("desktop byte formatters", () => {
	it("keep the English output unchanged", () => {
		for (const n of SAMPLES) {
			expect(downloadBytes(n)).toBe(legacyDownload(n));
			expect(uploadLimitBytes(n)).toBe(legacyUploadLimit(n));
			expect(importBytes(n)).toBe(legacyImport(n));
			expect(backupBytes(n)).toBe(legacyBackup(n));
			expect(formatSpeed(n)).toBe(legacySpeed(n));
		}
		expect(uploadLimitBytes(Number.NaN)).toBe("0 B");
		expect(uploadLimitBytes(-5)).toBe("0 B");
	});

	it("use the locale's decimal comma under de", () => {
		registerActiveI18nRuntime(german);
		expect(downloadBytes(1536)).toContain("1,5");
		expect(uploadLimitBytes(1536)).toContain("1,5");
		expect(importBytes(1536)).toContain("1,5");
		expect(backupBytes(1536)).toContain("1,5");
		expect(formatSpeed(1_572_864)).toContain("1,5");
		expect(downloadBytes(1536)).not.toContain("1.5");
	});
});
