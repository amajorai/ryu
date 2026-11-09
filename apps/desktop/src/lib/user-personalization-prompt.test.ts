import { describe, expect, test } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import { DEFAULT_USER_PERSONALIZATION } from "@/src/lib/api/preferences.ts";
import {
	changedPersonalizationFields,
	personalizationCacheWarning,
} from "./user-personalization-prompt.ts";

const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

const saved = {
	aboutOrganization: "Cedar Research Group",
	aboutYou: "I build accessible tools.",
	nickname: "Rae",
	occupation: "Engineer",
};

describe("About you prompt-cache confirmation", () => {
	test("an unchanged or whitespace-only edit asks nothing", () => {
		expect(changedPersonalizationFields(saved, { ...saved }, tl)).toEqual([]);
		expect(
			personalizationCacheWarning(
				saved,
				{
					...saved,
					nickname: "  Rae ",
					aboutYou: "I build accessible tools.\n",
				},
				tl
			)
		).toBeNull();
	});

	test("names each changed field in prompt order and reaches every thread", () => {
		const after = {
			...saved,
			aboutOrganization: "",
			nickname: "Ray",
		};
		expect(changedPersonalizationFields(saved, after, tl)).toEqual([
			"Nickname",
			"About your organization",
		]);
		const warning = personalizationCacheWarning(saved, after, tl);
		expect(warning?.title).toBe("Apply now? This resets the prompt cache");
		expect(warning?.description).toStartWith(
			"Nickname and About your organization are part of the system prompt for every thread on this node."
		);
	});

	test("filling an empty profile counts as a change", () => {
		expect(
			personalizationCacheWarning(
				DEFAULT_USER_PERSONALIZATION,
				{
					...DEFAULT_USER_PERSONALIZATION,
					aboutYou: "Hello",
				},
				tl
			)?.description
		).toStartWith("More about you is part of the system prompt");
	});

	test("non-string values read as empty, like Core", () => {
		const corrupt = {
			...DEFAULT_USER_PERSONALIZATION,
			nickname: 42,
			occupation: null,
		} as unknown as typeof DEFAULT_USER_PERSONALIZATION;
		expect(
			changedPersonalizationFields(corrupt, DEFAULT_USER_PERSONALIZATION, tl)
		).toEqual([]);
		expect(
			changedPersonalizationFields(
				corrupt,
				{
					...DEFAULT_USER_PERSONALIZATION,
					nickname: "42",
				},
				tl
			)
		).toEqual(["Nickname"]);
	});

	test("field labels reach the confirmation in the reader's language", () => {
		const ja: Record<string, string> = {
			Nickname: "ニックネーム",
			"{number, select, singular {{list} is part of the system prompt for {reach}. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.} other {{list} are part of the system prompt for {reach}. Each thread's next message re-sends its whole conversation at the full input price, once; replies after that are cached again. Switching models costs the same.}}":
				"{list}は{reach}のシステムプロンプトの一部です。",
			"every thread on this node": "このノードのすべてのスレッド",
		};
		const japanese: LiteralMessage = (source, values) =>
			formatMessage(ja[source] ?? source, values ?? {});
		const after = { ...saved, nickname: "Ray" };
		expect(changedPersonalizationFields(saved, after, japanese)).toEqual([
			"ニックネーム",
		]);
		const description =
			personalizationCacheWarning(saved, after, japanese)?.description ?? "";
		expect(description).toBe(
			"ニックネームはこのノードのすべてのスレッドのシステムプロンプトの一部です。"
		);
		expect(description).not.toContain("Nickname");
	});
});
