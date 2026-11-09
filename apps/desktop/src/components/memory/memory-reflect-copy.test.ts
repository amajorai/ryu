import { describe, expect, it } from "bun:test";
import { formatMessage, type LiteralMessage } from "@ryu/i18n";
import {
	reflectActivityLabel,
	topicSummaryText,
} from "./memory-reflect-copy.ts";

const PLURAL = "{count, plural, one {# message} other {# messages}}";

function translator(
	locale: string,
	catalog: Record<string, string>
): LiteralMessage {
	return (source, values) =>
		formatMessage(catalog[source] ?? source, values ?? {}, locale);
}

const tlJa = translator("ja", {
	"Active days": "アクティブな日数",
	"Activity events": "アクティビティイベント",
	Conversations: "会話",
	Messages: "メッセージ",
	[PLURAL]: "{count, plural, other {# 件のメッセージ}}",
});

const tlAr = translator("ar", {
	[PLURAL]:
		"{count, plural, zero {لا رسائل} one {رسالة واحدة} two {رسالتان} few {# رسائل} many {# رسالة} other {# رسالة}}",
});

const tlEn = translator("en", {});

describe("reflectActivityLabel", () => {
	it("translates each label Core sends", () => {
		expect(reflectActivityLabel("Conversations", tlJa)).toBe("会話");
		expect(reflectActivityLabel("Messages", tlJa)).toBe("メッセージ");
		expect(reflectActivityLabel("Active days", tlJa)).toBe("アクティブな日数");
		expect(reflectActivityLabel("Activity events", tlJa)).toBe(
			"アクティビティイベント"
		);
	});

	it("passes unknown labels through", () => {
		expect(reflectActivityLabel("Focus streak", tlJa)).toBe("Focus streak");
		expect(reflectActivityLabel("toString", tlJa)).toBe("toString");
	});
});

describe("topicSummaryText", () => {
	it("re-renders Core's message count as a plural", () => {
		expect(topicSummaryText("1 messages", tlEn)).toBe("1 message");
		expect(topicSummaryText("4 messages", tlEn)).toBe("4 messages");
		expect(topicSummaryText("7 messages", tlJa)).toBe("7 件のメッセージ");
	});

	it("uses the Arabic dual and few forms", () => {
		expect(topicSummaryText("2 messages", tlAr)).toBe("رسالتان");
		expect(topicSummaryText("3 messages", tlAr)).toBe("3 رسائل");
		expect(topicSummaryText("1 message", tlAr)).toBe("رسالة واحدة");
	});

	it("passes any other summary through", () => {
		expect(topicSummaryText("Mostly about travel", tlJa)).toBe(
			"Mostly about travel"
		);
	});
});
