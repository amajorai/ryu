import { describe, expect, test } from "bun:test";

import { createCliTranslator } from "../../i18n/translate.ts";
import {
	type DownloadLabelI18n,
	downloadKindLabel,
	progressBadge,
} from "./progress-badge.ts";

const MB = 1024 * 1024;

const english: DownloadLabelI18n = {
	...createCliTranslator("en", null),
	formatLocale: "en",
};

const german: DownloadLabelI18n = {
	...createCliTranslator("de", {
		"{state} {progress}": "{state} {progress}",
		active: "aktiv",
		cancelled: "abgebrochen",
		paused: "pausiert",
		model: "Modell",
	}),
	formatLocale: "de",
};

describe("progressBadge", () => {
	test("shows the state with percent complete", () => {
		const task = {
			received_bytes: 45,
			state: "active",
			total_bytes: 100,
		} as const;
		expect(progressBadge(task, english)).toBe("active 45%");
		// Intl joins the number and unit with a no-break space.
		expect(progressBadge(task, german)).toBe("aktiv 45\u00a0%");
	});

	test("shows the received size when the total is unknown", () => {
		const task = {
			received_bytes: 1.5 * MB,
			state: "paused",
			total_bytes: null,
		} as const;
		expect(progressBadge(task, english)).toBe("paused 1.5 MB");
		// ICU picks a plain or no-break space per unit; the decimal comma is the point.
		expect(progressBadge(task, german)).toMatch(/^pausiert 1,5\s+MB$/u);
	});

	test("shows the bare translated state before any bytes arrive", () => {
		const task = {
			received_bytes: 0,
			state: "cancelled",
			total_bytes: null,
		} as const;
		expect(progressBadge(task, german)).toBe("abgebrochen");
		expect(progressBadge(task, english)).toBe("cancelled");
	});

	test("formats the progress in Japanese and Arabic", () => {
		const japanese: DownloadLabelI18n = {
			...createCliTranslator("ja", { active: "実行中" }),
			formatLocale: "ja",
		};
		const arabic: DownloadLabelI18n = {
			...createCliTranslator("ar", {
				"{state} {progress}": "{state} {progress}",
				paused: "متوقف مؤقتًا",
			}),
			formatLocale: "ar",
		};
		const active = {
			received_bytes: 45,
			state: "active",
			total_bytes: 100,
		} as const;
		expect(progressBadge(active, japanese)).toBe("実行中 45%");
		const paused = {
			received_bytes: 1.5 * MB,
			state: "paused",
			total_bytes: null,
		} as const;
		const badge = progressBadge(paused, arabic);
		expect(badge.startsWith("متوقف مؤقتًا ")).toBe(true);
		expect(badge).not.toContain("1.5 MB");
		expect(badge).toContain(
			new Intl.NumberFormat("ar", { minimumFractionDigits: 1 }).format(1.5)
		);
	});

	test("translates the kind subtitle", () => {
		expect(downloadKindLabel("model", german)).toBe("Modell");
		expect(downloadKindLabel("mcp", english)).toBe("MCP");
	});
});
