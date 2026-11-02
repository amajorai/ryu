import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorMessage } from "../error-message.tsx";
import {
	type CoreErrorTranslate,
	localizeCoreError,
} from "./core-error-text.ts";

/** A stand-in catalog: German wording for two Core sources. */
const german: CoreErrorTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		"Agent failed to start": "Agent konnte nicht starten",
		"The agent could not start, so the message was not sent. Send it again to retry. (details: {detail})":
			"Der Agent konnte nicht starten. Senden Sie die Nachricht erneut. (Details: {detail})",
	};
	return formatMessage(catalog[source] ?? source, values, "de");
};

const startFailure = {
	code: "agent_start_failed",
	i18n: {
		body: [
			{
				args: { detail: "spawn ENOENT" },
				message:
					"The agent could not start, so the message was not sent. Send it again to retry. (details: {detail})",
			},
		],
		join: "sentences",
		title: { args: {}, message: "Agent failed to start" },
	},
	message:
		"The agent could not start, so the message was not sent. Send it again to retry. (details: spawn ENOENT)",
	title: "Agent failed to start",
};

test("renders the card's messages in the active locale, values verbatim", () => {
	expect(localizeCoreError(startFailure, german, "de")).toEqual({
		message:
			"Der Agent konnte nicht starten. Senden Sie die Nachricht erneut. (Details: spawn ENOENT)",
		title: "Agent konnte nicht starten",
	});
	const markup = renderToStaticMarkup(
		<ErrorMessage {...localizeCoreError(startFailure, german, "de")} />
	);
	expect(markup).toContain("Agent konnte nicht starten");
});

test("a relayed raw error keeps its stored message under a localized title", () => {
	const relayed = {
		i18n: {
			body: [],
			join: "sentences",
			title: { message: "Agent failed to start" },
		},
		message: "refresh revoked",
		title: "Agent failed to start",
	};
	expect(localizeCoreError(relayed, german, "de")).toEqual({
		message: "refresh revoked",
		title: "Agent konnte nicht starten",
	});
});

test("joins sentences like Core: no space in Japanese after translated text", () => {
	const japanese: CoreErrorTranslate = (source) =>
		({ One: "一。", Two: "二。" })[source] ?? source;
	const part = {
		i18n: {
			body: [{ message: "One" }, { message: "Two" }],
			join: "sentences",
			title: { message: "Title" },
		},
		message: "One Two",
	};
	expect(localizeCoreError(part, japanese, "ja").message).toBe("一。二。");
	expect(localizeCoreError(part, japanese, "de").message).toBe("一。 二。");
	expect(
		localizeCoreError(
			{ ...part, i18n: { ...part.i18n, join: "lines" } },
			japanese,
			"ja"
		).message
	).toBe("一。\n二。");
});

test("a two-sentence sandbox refusal renders in Arabic and Japanese", () => {
	// The wire Core writes for `account_sandbox_failure` (start_failures.rs).
	const sandbox = {
		i18n: {
			body: [
				{
					args: { reason: "no bwrap" },
					message: "Ryu could not set that sandbox up ({reason}).",
				},
				{ args: {}, message: "Set the agent's Identity to Acts as you." },
			],
			join: "sentences",
			title: { args: {}, message: "Agent not started" },
		},
		message: "Ryu could not set that sandbox up (no bwrap). Set it.",
		title: "Agent not started",
	};
	const catalogs: Record<string, Record<string, string>> = {
		ar: {
			"Agent not started": "لم يبدأ الوكيل",
			"Ryu could not set that sandbox up ({reason}).":
				"تعذر على Ryu إعداد بيئة العزل ({reason}).",
			"Set the agent's Identity to Acts as you.":
				"اضبط هوية الوكيل على يتصرف نيابةً عنك.",
		},
		ja: {
			"Agent not started": "エージェントは起動していません",
			"Ryu could not set that sandbox up ({reason}).":
				"Ryu はサンドボックスを設定できませんでした ({reason})。",
			"Set the agent's Identity to Acts as you.":
				"エージェントの ID を「あなたとして動作」に設定してください。",
		},
	};
	const using =
		(locale: string): CoreErrorTranslate =>
		(source, values) =>
			formatMessage(catalogs[locale]?.[source] ?? source, values, locale);
	expect(localizeCoreError(sandbox, using("ar"), "ar")).toEqual({
		message:
			"تعذر على Ryu إعداد بيئة العزل (no bwrap). اضبط هوية الوكيل على يتصرف نيابةً عنك.",
		title: "لم يبدأ الوكيل",
	});
	expect(localizeCoreError(sandbox, using("ja"), "ja")).toEqual({
		message:
			"Ryu はサンドボックスを設定できませんでした (no bwrap)。エージェントの ID を「あなたとして動作」に設定してください。",
		title: "エージェントは起動していません",
	});
});

test("an older row or a malformed message keeps the stored English", () => {
	const stored = { message: "Stored message", title: "Stored title" };
	expect(localizeCoreError(stored, german, "de")).toEqual(stored);
	expect(
		localizeCoreError(
			{
				...stored,
				i18n: {
					body: [{ args: { detail: { nested: true } }, message: "x {detail}" }],
					title: { message: "" },
				},
			},
			german,
			"de"
		)
	).toEqual(stored);
});
