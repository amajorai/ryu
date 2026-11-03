import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { formatDurationUnit } from "@ryu/i18n/format-intl";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";
import {
	type PassportGatewayDetailsInput,
	passportControlDetails,
	passportGatewayDetails,
} from "./agent-passport-details.ts";
import type { OrganizationAuditEntry } from "./api/orgs.ts";

const JA: Record<string, string> = {
	"Change accepted by the control plane":
		"コントロールプレーンが変更を受け付けました",
	"Cost {amount}": "コスト {amount}",
	"Duration {duration}": "所要時間 {duration}",
	"Error: {message}": "エラー: {message}",
	"Latency {duration}": "レイテンシ {duration}",
	No: "いいえ",
	"No additional metadata": "追加のメタデータはありません",
	"Surface {name}": "サーフェス {name}",
	Yes: "はい",
	"{count, plural, one {# token} other {# tokens}}":
		"{count, plural, other {# トークン}}",
};

function runtimeFor(locale: string, messages: Record<string, string> = {}) {
	return {
		direction: "ltr" as const,
		locale,
		translate(source: string, values?: MessageValuesInput, fallback?: string) {
			const key = fallback ?? source;
			return formatMessage(messages[key] ?? key, values, locale);
		},
	};
}

let mounted: ReturnType<typeof runtimeFor> | null = null;

function mount(runtime: ReturnType<typeof runtimeFor>): void {
	mounted = runtime;
	registerActiveI18nRuntime(runtime);
}

afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(mounted);
		mounted = null;
	}
});

function modelCall(
	overrides: Partial<PassportGatewayDetailsInput> = {}
): PassportGatewayDetailsInput {
	return {
		backend: null,
		command: null,
		costMicroUsd: 1200,
		durationMs: null,
		error: null,
		eventType: "model_call",
		feature: "chat",
		inputTokens: 12_000,
		latencyMs: 840,
		model: "gpt-5",
		outputTokens: 345,
		provider: "openai",
		...overrides,
	};
}

function controlChange(
	details: OrganizationAuditEntry["details"]
): OrganizationAuditEntry {
	return {
		action: "agent.update",
		actor: { email: null, id: null, name: null, type: "system" },
		agentId: null,
		details,
		error: null,
		eventType: "control_change",
		feature: null,
		id: "control-1",
		requestId: null,
		scope: "gateway",
		sessionId: null,
		target: "agent:a",
		targetId: null,
		timestamp: "2026-09-01T09:00:00.000Z",
	};
}

const ENGLISH_WORDS =
	/\b(tokens?|latency|duration|cost|surface|error|yes|no)\b/iu;

describe("agent passport details follow the UI language", () => {
	test("English rows read as whole phrases with grouped numbers", () => {
		expect(passportGatewayDetails(modelCall())).toBe(
			"openai · gpt-5 · 12,345 tokens · Latency 840ms · Surface chat · Cost $0.0012"
		);
		expect(
			passportGatewayDetails(
				modelCall({
					costMicroUsd: null,
					durationMs: 1500,
					error: "timeout",
					eventType: "exec_call",
					feature: null,
				})
			)
		).toBe("Duration 1500ms · Error: timeout");
	});

	test("a Japanese model row has formatted values and no English words", () => {
		mount(runtimeFor("ja", JA));
		const details = passportGatewayDetails(
			modelCall({ error: "upstream", feature: "chat" })
		);
		const parts = details.split(" · ");
		expect(parts[2]).toBe("12,345 トークン");
		expect(parts[3]).toBe(
			`レイテンシ ${formatDurationUnit(840, "millisecond", 0, "ja")}`
		);
		expect(parts[4]).toBe("サーフェス chat");
		expect(parts[5]).toStartWith("コスト ");
		expect(parts[5]).toContain("0.0012");
		expect(parts[6]).toBe("エラー: upstream");
		expect(details.replace("openai · gpt-5", "")).not.toMatch(ENGLISH_WORDS);
	});

	test("German groups the token count and puts the currency symbol last", () => {
		mount(runtimeFor("de"));
		expect(passportGatewayDetails(modelCall())).toContain("12.345 tokens");
		expect(passportGatewayDetails(modelCall())).toMatch(/Cost 0,0012\s\$/u);
	});

	test("Arabic uses the locale's duration unit and currency form", () => {
		mount(runtimeFor("ar"));
		const details = passportGatewayDetails(modelCall());
		expect(details).toContain(
			`Latency ${formatDurationUnit(840, "millisecond", 0, "ar")}`
		);
		expect(details).not.toContain("840ms");
		expect(details).not.toContain("$0.0012");
		expect(details).toMatch(/Cost \S*0\.0012/u);
	});

	test("control-change flags read yes/no in the UI language", () => {
		mount(runtimeFor("ja", JA));
		expect(
			passportControlDetails(controlChange({ dryRun: false, status: 200 }))
		).toBe("dryRun: いいえ · status: 200");
		expect(passportControlDetails(controlChange({}))).toBe(
			"コントロールプレーンが変更を受け付けました"
		);
		expect(
			passportGatewayDetails(
				modelCall({ costMicroUsd: null, eventType: "x", feature: null })
			)
		).toBe("追加のメタデータはありません");
	});
});
