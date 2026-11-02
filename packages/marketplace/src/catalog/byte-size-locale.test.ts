import { afterEach, describe, expect, test } from "bun:test";
import { formatDocumentSize } from "@ryu/blocks/desktop/spaces-document-format.ts";
import { formatFileSize } from "@ryu/ui/lib/data-grid.ts";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import { formatRepoSize } from "./models/model-install-actions.tsx";

let mounted: ActiveI18nRuntime | null = null;

/** Intl separates number and unit with a no-break space. */
const spaced = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

function showLocale(locale: string): void {
	mounted = {
		direction: locale === "ar" ? "rtl" : "ltr",
		locale,
		translate: (source) => source,
	};
	registerActiveI18nRuntime(mounted);
}

afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(mounted);
		mounted = null;
	}
});

describe("byte sizes follow the UI locale", () => {
	test("English keeps the hand-built strings", () => {
		expect(formatRepoSize(4.7e9)).toBe("4.7 GB");
		expect(formatRepoSize(420e6)).toBe("420 MB");
		expect(formatFileSize(1536)).toBe("1.5 KB");
		expect(formatDocumentSize(2048)).toBe("2 KB");
	});

	test("German uses its decimal comma and unit names", () => {
		showLocale("de");
		expect(spaced(formatRepoSize(4.7e9))).toBe("4,7 GB");
		expect(spaced(formatFileSize(1536))).toBe("1,5 kB");
		expect(spaced(formatDocumentSize(1536))).toBe("1,5 kB");
	});

	test("Japanese and Arabic stop reading as English", () => {
		showLocale("ja");
		expect(formatRepoSize(4.7e9)).toBe(
			new Intl.NumberFormat("ja", {
				maximumFractionDigits: 1,
				minimumFractionDigits: 1,
				style: "unit",
				unit: "gigabyte",
				unitDisplay: "short",
			}).format(4.7)
		);
		unregisterActiveI18nRuntime(mounted as ActiveI18nRuntime);
		showLocale("ar");
		expect(formatFileSize(1536)).not.toBe("1.5 KB");
		expect(formatFileSize(1536)).toContain("كيلوبايت");
	});
});
