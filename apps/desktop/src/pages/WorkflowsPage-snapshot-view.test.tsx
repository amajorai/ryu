import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { WorkflowSnapshotView, workflowSnapshotDisplay } = await import(
	"./WorkflowsPage-snapshot-view.tsx"
);

// The DOM localizer skips `<pre>`, so the card must translate its own labels.
const JA: Record<string, string> = {
	"(empty — no nodes yet)": "(空 — ノードはまだありません)",
	"(none)": "(なし)",
	"Description: {description}": "説明: {description}",
	"Edges:": "エッジ:",
	manual: "手動",
	"Name: {name}": "名前: {name}",
	"Nodes:": "ノード:",
	"Triggers: {triggers}": "トリガー: {triggers}",
};

const WORKFLOW = {
	chatInput: false,
	description: "Daily digest",
	edges: [{ branch: "yes", from: "input_1", to: "llm_2" }],
	id: "wf_1",
	name: "Digest",
	nodes: [
		{ id: "input_1", type: "Input" },
		{ id: "llm_2", type: "Llm" },
	],
	triggers: [],
} as never;

const roots: Root[] = [];

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function renderJa(workflow: unknown): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<WorkflowSnapshotView workflow={workflow as never} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	return container.querySelector("pre")?.textContent ?? "";
}

test("translates the card labels under ja and keeps node ids verbatim", async () => {
	const text = await renderJa(WORKFLOW);
	expect(text).toContain("名前: Digest");
	expect(text).toContain("説明: Daily digest");
	expect(text).toContain("トリガー: 手動");
	expect(text).toContain("ノード:\n  - input_1 (Input)\n  - llm_2 (Llm)");
	expect(text).toContain("エッジ:\n  - input_1 -> llm_2 [yes]");
	expect(text).not.toContain("Name:");
	expect(text).not.toContain("manual");
});

test("translates the empty-workflow placeholder under ja", async () => {
	expect(await renderJa(null)).toBe("(空 — ノードはまだありません)");
});

test("falls back to English and marks empty lists with (none)", () => {
	const identity = (source: string, values: Record<string, unknown> = {}) =>
		source.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
	const text = workflowSnapshotDisplay(
		{ ...(WORKFLOW as object), edges: [], nodes: [] } as never,
		identity as never
	);
	expect(text).toBe(
		"Name: Digest\nDescription: Daily digest\nTriggers: manual\nNodes:\n  (none)\nEdges:\n  (none)"
	);
});
