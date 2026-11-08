import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import {
	cloudTaskNoticeText,
	type NoticeTranslate,
} from "./cloud-task-notice-text.ts";

const QUOTA =
	"Your {planName} plan ({account}) reached its usage or rate limit. Ryu tries the next option: another account only if you listed it, otherwise a Ryu Box, which uses Ryu credits.";

const japanese: NoticeTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		[QUOTA]:
			"{planName} プラン ({account}) が使用量またはレートの上限に達しました。次の候補を試します。",
	};
	return formatMessage(catalog[source] ?? source, values, "ja");
};

const english =
	"Your Claude plan (work) reached its usage or rate limit. Ryu tries the next option: another account only if you listed it, otherwise a Ryu Box, which uses Ryu credits.";

test("renders the notice's Core message in the reader's locale", () => {
	expect(
		cloudTaskNoticeText(
			{
				i18n: {
					args: { account: "work", planName: "Claude" },
					message: QUOTA,
				},
				message: english,
			},
			japanese
		)
	).toBe(
		"Claude プラン (work) が使用量またはレートの上限に達しました。次の候補を試します。"
	);
});

test("an older Core's notice, or a malformed one, shows its English text", () => {
	expect(cloudTaskNoticeText({ i18n: null, message: english }, japanese)).toBe(
		english
	);
	expect(
		cloudTaskNoticeText(
			{ i18n: { args: { account: {} }, message: QUOTA }, message: english },
			japanese
		)
	).toBe(english);
});

test("renders a notice in German and in Arabic from the same Core message", () => {
	const NOT_INSTALLED = "{cliName} is not installed on this node.";
	const catalogs: Record<string, Record<string, string>> = {
		ar: { [NOT_INSTALLED]: "{cliName} غير مثبت على هذه العقدة." },
		de: {
			[NOT_INSTALLED]: "{cliName} ist auf diesem Knoten nicht installiert.",
		},
	};
	const notice = {
		i18n: { args: { cliName: "Codex" }, message: NOT_INSTALLED },
		message: "Codex is not installed on this node.",
	};
	for (const [locale, expected] of [
		["de", "Codex ist auf diesem Knoten nicht installiert."],
		["ar", "\u2068Codex\u2069 غير مثبت على هذه العقدة."],
	] as const) {
		const tl: NoticeTranslate = (source, values) =>
			formatMessage(catalogs[locale]?.[source] ?? source, values, locale);
		expect(cloudTaskNoticeText(notice, tl)).toBe(expected);
	}
});
