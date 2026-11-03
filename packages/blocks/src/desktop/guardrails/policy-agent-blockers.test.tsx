// The agent-assignment blocker sentence and the preview warnings must read in
// the UI language: translated field names joined with the locale's list
// pattern, never English names glued with ", ".

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider, useLiteralMessages } = await import("@ryu/i18n/react");
const { agentUnsupportedFieldList } = await import(
	"./policy-agent-blockers.ts"
);
const { agentUnsupportedFields, emptyPolicyRules, previewWarningText } =
	await import("./policy-model.ts");

const BLOCKER_SENTENCE =
	"An agent assignment carries firewall settings and evaluators only. Remove {fields} first.";
const NO_MODEL_WARNING =
	"No model is eligible at this scope. The allowlists above and the Ryu platform policy leave nothing in common, so every request would be refused.";

const JA: Record<string, string> = {
	[BLOCKER_SENTENCE]:
		"エージェントへの割り当てに含められるのはファイアウォール設定と評価器のみです。先に{fields}を削除してください。",
	[NO_MODEL_WARNING]: "このスコープで利用できるモデルがありません。",
	"approved models": "承認済みモデル",
	"locked fields": "ロックされた項目",
	"spend cap": "利用上限",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderIn(locale: string, node: ReactNode): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.textContent ?? "";
}

const blockingRules = {
	...emptyPolicyRules(),
	approvedModels: ["openai/gpt-5"],
	budgets: [{ usdMicro: 1_000_000, window: "monthly" as const }],
};

/** The sentence exactly as the assignments panel composes it. */
function BlockerSentence() {
	const tl = useLiteralMessages();
	const blockers = agentUnsupportedFields(blockingRules, ["approvedModels"]);
	return (
		<p>
			{tl(BLOCKER_SENTENCE, {
				fields: agentUnsupportedFieldList(blockers),
			})}
		</p>
	);
}

function WarningProbe() {
	return <p>{previewWarningText("no_models_eligible")}</p>;
}

describe("agent-assignment blockers", () => {
	test("reads in English with an English list", async () => {
		const text = await renderIn("en", <BlockerSentence />);
		expect(text).toBe(
			"An agent assignment carries firewall settings and evaluators only. Remove approved models, spend cap, and locked fields first."
		);
	});

	test("names the fields in Japanese, joined with the Japanese separator", async () => {
		const text = await renderIn("ja", <BlockerSentence />);
		expect(text).toBe(
			"エージェントへの割り当てに含められるのはファイアウォール設定と評価器のみです。先に承認済みモデル、利用上限、ロックされた項目を削除してください。"
		);
		expect(text).not.toContain("approved models");
		expect(text).not.toContain(", ");
	});

	test("preview warnings follow the UI language; unknown codes show as sent", async () => {
		expect(await renderIn("ja", <WarningProbe />)).toBe(
			"このスコープで利用できるモデルがありません。"
		);
		expect(previewWarningText("toString")).toBe("toString");
		expect(previewWarningText("brand_new_code")).toBe("brand_new_code");
	});
});
