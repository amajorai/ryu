import { describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import {
	localizeUsageTaskLabel,
	type UsageTaskTranslator,
	usageWindowRange,
} from "./usage-task-label.ts";

// Stub catalogs: just the sources these rows use, so each case shows the
// reader's language rather than the English template.
const JA: Record<string, string> = {
	"1 Composio tool call (Connect)": "Composio ツール呼び出し 1 回 (Connect)",
	"1 native {toolkit} tool call (Connect)":
		"ネイティブ {toolkit} ツール呼び出し 1 回 (Connect)",
	"1 run of composed tool {tool} v{version} (maker fee, Connect)":
		"合成ツール {tool} v{version} の実行 1 回 (作成者手数料、Connect)",
	"1 {endpoint} call on Ryu's key (Connect)":
		"Ryu のキーでの {endpoint} 呼び出し 1 回 (Connect)",
	"Box storage": "Box ストレージ",
	"Box session {box}": "Box セッション {box}",
	"Box usage reconciliation": "Box 使用量の照合",
	"Composio {action} via Treg": "Treg 経由の Composio {action}",
	"Delivered Composio trigger event": "配信された Composio トリガーイベント",
	"Image generation": "画像生成",
	"Inbound SMS from {party}": "{party} からの受信 SMS",
	"Inbound voice message from {party}": "{party} からの受信音声メッセージ",
	"Mail overage: {count, plural, one {# recipient} other {# recipients}}":
		"メール超過: 受信者 {count} 人",
	"Managed Agents session {session}": "Managed Agents セッション {session}",
	"Phone number lease {which} (period {period})":
		"電話番号のリース {which} (期間 {period})",
	"SMS to {party} ({count, plural, one {# part} other {# parts}})":
		"{party} への SMS ({count} 分割)",
	"SMS to {party}": "{party} への SMS",
	"Text to speech": "音声合成",
	"WhatsApp message to {party}": "{party} への WhatsApp メッセージ",
	"Web fetch": "ウェブ取得",
	"Web search": "ウェブ検索",
	"{count, plural, one {# {provider} tool call} other {# {provider} tool calls}}":
		"{provider} ツール呼び出し {count} 回",
	"{label} (estimated cost)": "{label} (推定費用)",
	"Box usage, {window}": "Box の使用量、{window}",
	"a recipient": "受信者",
};

const AR: Record<string, string> = {
	"Inbound SMS from {party}": "رسالة SMS واردة من {party}",
	"SMS to {party}": "رسالة SMS إلى {party}",
	"a recipient": "مستلم",
};

const DE: Record<string, string> = {
	"Mail overage: {count, plural, one {# recipient} other {# recipients}}":
		"Mail-Überschreitung: {count, plural, one {# Empfänger} other {# Empfänger}}",
	"Plan credits taken back after a refund (complete)":
		"Plan-Guthaben nach einer Rückerstattung zurückgenommen (abgeschlossen)",
	"Box usage, {window}": "Box-Nutzung, {window}",
};

const catalog =
	(messages: Record<string, string>, locale: string): UsageTaskTranslator =>
	(source, values) =>
		formatMessage(messages[source] ?? source, values ?? {}, locale);

const ja = catalog(JA, "ja");
const de = catalog(DE, "de");
const ar = catalog(AR, "ar");

describe("localizeUsageTaskLabel", () => {
	test.each([
		[
			"1 composio tool call (Connect)",
			"Composio ツール呼び出し 1 回 (Connect)",
		],
		[
			"1 native github tool call (Connect)",
			"ネイティブ github ツール呼び出し 1 回 (Connect)",
		],
		[
			"1 run of composed tool lead-enricher v1.2.0 (maker fee, Connect)",
			"合成ツール lead-enricher v1.2.0 の実行 1 回 (作成者手数料、Connect)",
		],
		[
			"1 search.places call on Ryu's key (Connect)",
			"Ryu のキーでの search.places 呼び出し 1 回 (Connect)",
		],
		["box-storage", "Box ストレージ"],
		["box-reconcile", "Box 使用量の照合"],
		["box:bx_0123", "Box セッション bx_0123"],
		["web_search", "ウェブ検索"],
		["web_fetch", "ウェブ取得"],
		["managed-agents:ses_42", "Managed Agents セッション ses_42"],
		["Inbound SMS from +1…42", "+1…42 からの受信 SMS"],
		["Inbound Voice message from +1…42", "+1…42 からの受信音声メッセージ"],
		["SMS to +1…42", "+1…42 への SMS"],
		["SMS to +1…42 (3 parts)", "+1…42 への SMS (3 分割)"],
		["WhatsApp to +1…42", "+1…42 への WhatsApp メッセージ"],
		["Phone number lease +1…42 (period 2)", "電話番号のリース +1…42 (期間 2)"],
		["Mail overage: 120 recipients", "メール超過: 受信者 120 人"],
		["1 exa tool call", "exa ツール呼び出し 1 回"],
		["3 exa tool calls", "exa ツール呼び出し 3 回"],
		["1 Treg tool call", "Treg ツール呼び出し 1 回"],
		["composio GMAIL_SEND via treg", "Treg 経由の Composio GMAIL_SEND"],
		[
			"Delivered Composio trigger event",
			"配信された Composio トリガーイベント",
		],
		["image", "画像生成"],
		["tts (estimated cost)", "音声合成 (推定費用)"],
	])("renders %p in Japanese", (label, expected) => {
		expect(localizeUsageTaskLabel(label, ja, "ja")).toBe(expected);
	});

	test("shows the metered window as a locale date range, not ISO", () => {
		const label = "box usage 2026-11-06T10:00:00.000Z–2026-11-06T11:00:00.000Z";
		const range = usageWindowRange(
			"2026-11-06T10:00:00.000Z",
			"2026-11-06T11:00:00.000Z",
			"de"
		);
		expect(range).not.toBeNull();
		const german = localizeUsageTaskLabel(label, de, "de");
		expect(german).toBe(`Box-Nutzung, ${range}`);
		expect(german).not.toContain("2026-11-06T");
		expect(german).toContain("2026");
		const japanese = localizeUsageTaskLabel(label, ja, "ja");
		expect(japanese).toContain("Box の使用量、");
		expect(japanese).toContain("2026/11/06");
	});

	test("renders German plurals and refund labels", () => {
		expect(localizeUsageTaskLabel("Mail overage: 1 recipients", de, "de")).toBe(
			"Mail-Überschreitung: 1 Empfänger"
		);
		expect(
			localizeUsageTaskLabel(
				"Plan credits taken back after a refund (complete)",
				de,
				"de"
			)
		).toBe(
			"Plan-Guthaben nach einer Rückerstattung zurückgenommen (abgeschlossen)"
		);
	});

	test("leaves a user or agent task name unchanged", () => {
		for (const name of [
			"Weekly report for Acme",
			"Summarize inbox",
			"SMS campaign draft",
			"composio thing",
			"photo (estimated cost)",
			"box usage yesterday–today",
		]) {
			expect(localizeUsageTaskLabel(name, ja, "ja")).toBe(name);
		}
	});

	test("translates the producer's stand-in for an unmaskable number", () => {
		expect(localizeUsageTaskLabel("SMS to a recipient", ja, "ja")).toBe(
			"受信者 への SMS"
		);
		expect(
			localizeUsageTaskLabel("Inbound SMS from a recipient", ar, "ar")
		).toBe("رسالة SMS واردة من مستلم");
	});

	test("lays a masked number out left to right in Arabic", () => {
		expect(localizeUsageTaskLabel("SMS to +1…42", ar, "ar")).toBe(
			"رسالة SMS إلى \u2066+1…42\u2069"
		);
		// Left-to-right locales get no isolate marks.
		expect(localizeUsageTaskLabel("SMS to +1…42", ja, "ja")).toBe(
			"+1…42 への SMS"
		);
	});

	test("an unknown service or bad timestamp keeps the stored label", () => {
		const label = "box usage not-a-date–2026-11-06T11:00:00.000Z";
		expect(localizeUsageTaskLabel(label, ja, "ja")).toBe(label);
	});
});
