import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import { type ApprovalTranslate, localizeApproval } from "./approval-text.ts";

const english: ApprovalTranslate = (source, values) =>
	formatMessage(source, values, "en");

/** A stand-in catalog: German wording for two Core sources. */
const german: ApprovalTranslate = (source, values) => {
	const catalog: Record<string, string> = {
		"Send this reply to {recipients}?": "Diese Antwort an {recipients} senden?",
		"the sender of the message": "den Absender der Nachricht",
		"Tool call: {tool}": "Werkzeugaufruf: {tool}",
	};
	return formatMessage(catalog[source] ?? source, values, "de");
};

const stored = {
	question: "Send this reply to the sender of the message?",
	summary: "Nova wants to reply.\n\nThanks!",
	title: "Tool call: agent_inbox.reply",
};

const i18n = {
	question: {
		args: { recipients: { args: {}, message: "the sender of the message" } },
		message: "Send this reply to {recipients}?",
	},
	summary: [
		{ args: { sender: "Nova" }, message: "{sender} wants to reply." },
		{ text: "\n\n" },
		{ text: "Thanks!" },
	],
	title: { args: { tool: "agent_inbox.reply" }, message: "Tool call: {tool}" },
};

test("renders the messages in the active locale, values verbatim", () => {
	expect(localizeApproval({ ...stored, i18n }, german)).toEqual({
		question: "Diese Antwort an den Absender der Nachricht senden?",
		summary: "Nova wants to reply.\n\nThanks!",
		title: "Werkzeugaufruf: agent_inbox.reply",
	});
});

test("English rendering equals the stored text", () => {
	expect(localizeApproval({ ...stored, i18n }, english)).toEqual(stored);
});

test("numbers arrive as number objects", () => {
	const text = localizeApproval(
		{
			...stored,
			i18n: {
				...i18n,
				summary: [
					{
						args: { hidden: { max_fraction: 0, min_fraction: 0, number: 50 } },
						message:
							"{hidden} more characters of the message are not shown here.",
					},
				],
			},
		},
		english
	);
	expect(text.summary).toBe(
		"50 more characters of the message are not shown here."
	);
});

test("falls back to the stored English without or with broken messages", () => {
	expect(localizeApproval(stored, german)).toEqual(stored);
	expect(
		localizeApproval(
			{
				...stored,
				i18n: { question: { message: 4 }, summary: "x", title: {} },
			},
			german
		)
	).toEqual(stored);
	expect(
		localizeApproval(
			{ ...stored, question: null, i18n: { title: i18n.title } },
			german
		)
	).toEqual({
		question: null,
		summary: stored.summary,
		title: "Werkzeugaufruf: agent_inbox.reply",
	});
});
