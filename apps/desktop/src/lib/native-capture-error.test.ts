import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	describeNativeCaptureError,
	formatNativeCaptureError,
} from "./native-capture-error.ts";

// A stand-in translator that marks every sentence it was asked for, so the
// assertions prove each code went through `tl()` as one whole message.
const tl: LiteralMessage = (source, values) =>
	`[${formatMessage(source, values ?? {}, "en")}]`;

describe("describeNativeCaptureError", () => {
	test("maps each user-actionable code to a whole translated sentence", () => {
		expect(
			describeNativeCaptureError({ code: "input_monitoring_denied" }, tl, "x")
		).toEqual({
			detail: null,
			message:
				"[Grant Input Monitoring to Ryu in System Settings › Privacy & Security, then restart Ryu.]",
		});
		expect(
			describeNativeCaptureError({ code: "quests_disabled" }, tl, "x").message
		).toBe(
			"[The Quests app is turned off. Enable it from the Store and try again.]"
		);
		expect(
			describeNativeCaptureError(
				{ code: "core_rejected", status: 503 },
				tl,
				"x"
			).message
		).toBe("[Ryu Core rejected the capture (HTTP 503).]");
	});

	test("keeps the technical cause as a separate detail", () => {
		expect(
			describeNativeCaptureError(
				{ code: "core_unreachable", detail: " connection refused " },
				tl,
				"x"
			)
		).toEqual({
			detail: "connection refused",
			message:
				"[Couldn't reach Ryu Core. Make sure Ryu is running and try again.]",
		});
	});

	test("an unknown code falls back to its detail, then to the fallback", () => {
		expect(
			describeNativeCaptureError(
				{ code: "brand_new_code", detail: "raw cause" },
				tl,
				"fallback"
			)
		).toEqual({ detail: null, message: "raw cause" });
		expect(
			describeNativeCaptureError({ code: "brand_new_code" }, tl, "fallback")
		).toEqual({ detail: null, message: "fallback" });
	});

	test("a bare string, an Error, or nothing still renders", () => {
		expect(describeNativeCaptureError("old text", tl, "f").message).toBe(
			"old text"
		);
		expect(describeNativeCaptureError(new Error("boom"), tl, "f").message).toBe(
			"boom"
		);
		expect(describeNativeCaptureError(null, tl, "f").message).toBe("f");
	});
});

describe("formatNativeCaptureError", () => {
	test("appends the detail through one translated message", () => {
		expect(
			formatNativeCaptureError(
				{ code: "settings_save_failed", detail: "os error 13" },
				tl,
				"f"
			)
		).toBe("[[Ryu couldn't save this setting.] Details: os error 13]");
		expect(formatNativeCaptureError({ code: "quests_disabled" }, tl, "f")).toBe(
			"[The Quests app is turned off. Enable it from the Store and try again.]"
		);
	});
});

// Stand-in catalogs: each source sentence is looked up whole, the way the real
// runtime resolves `tl()`, so a code never renders as English fragments.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		"Ryu Core rejected the capture (HTTP {status}).":
			"رفض Ryu Core الالتقاط (HTTP {status}).",
		"The Quests app is turned off. Enable it from the Store and try again.":
			"تطبيق Quests متوقف. فعّله من المتجر ثم حاول مرة أخرى.",
		"{message} Details: {detail}": "{message} التفاصيل: {detail}",
	},
	de: {
		"Ryu Core rejected the capture (HTTP {status}).":
			"Ryu Core hat die Erfassung abgelehnt (HTTP {status}).",
		"The Quests app is turned off. Enable it from the Store and try again.":
			"Die Quests-App ist ausgeschaltet. Aktiviere sie im Store und versuche es erneut.",
		"{message} Details: {detail}": "{message} Details: {detail}",
	},
	ja: {
		"Ryu Core rejected the capture (HTTP {status}).":
			"Ryu Core がキャプチャを拒否しました (HTTP {status})。",
		"The Quests app is turned off. Enable it from the Store and try again.":
			"Quests アプリがオフです。ストアで有効にしてから、もう一度お試しください。",
		"{message} Details: {detail}": "{message} 詳細: {detail}",
	},
};

function translatorFor(locale: string): LiteralMessage {
	const catalog = CATALOGS[locale] ?? {};
	return (source, values) =>
		formatMessage(catalog[source] ?? source, values ?? {}, locale);
}

describe("formatNativeCaptureError in other locales", () => {
	test.each([
		[
			"ja",
			"Ryu Core がキャプチャを拒否しました (HTTP 503)。 詳細: bad gateway",
			"Quests アプリがオフです。ストアで有効にしてから、もう一度お試しください。",
		],
		[
			"de",
			"Ryu Core hat die Erfassung abgelehnt (HTTP 503). Details: bad gateway",
			"Die Quests-App ist ausgeschaltet. Aktiviere sie im Store und versuche es erneut.",
		],
		[
			"ar",
			"رفض Ryu Core الالتقاط (HTTP 503). التفاصيل: \u2068bad gateway\u2069",
			"تطبيق Quests متوقف. فعّله من المتجر ثم حاول مرة أخرى.",
		],
	])("%s renders each code as one translated sentence", (locale, rejected, questsOff) => {
		const tl = translatorFor(locale);
		expect(
			formatNativeCaptureError(
				{ code: "core_rejected", detail: "bad gateway", status: 503 },
				tl,
				"f"
			)
		).toBe(rejected);
		expect(formatNativeCaptureError({ code: "quests_disabled" }, tl, "f")).toBe(
			questsOff
		);
	});
});
