// The Spaces home under a non-English UI: the template cards' accessible names and the
// document-view tabs are whole translated strings, so a screen reader never hears an
// English template name spliced into a Japanese "Create …" sentence.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { DocumentRow } = await import("./spaces-document-rows.tsx");
const { SpaceHomeShell } = await import("./spaces-home-shell.tsx");

const JA: Record<string, string> = {
	"Create {label}": "{label}を作成",
	"Blank document": "空白のドキュメント",
	"Welcome to Space": "Space へようこそ",
	"First table": "最初のテーブル",
	"Single spaced": "シングルスペース",
	"Blank board": "空白のボード",
	Recent: "最近",
	Pinned: "ピン留め",
	"Shared with Me": "共有アイテム",
	"Open {title}": "{title}を開く",
	Untitled: "無題",
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

async function renderInJapanese(node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

const ariaLabels = (container: HTMLElement) =>
	[...container.querySelectorAll("[aria-label]")].map(
		(element) => element.getAttribute("aria-label") ?? ""
	);

describe("Spaces home in Japanese", () => {
	test("template card names and view tabs are fully translated", async () => {
		const container = await renderInJapanese(
			<SpaceHomeShell
				documents={[]}
				space={{ documentCount: 0, id: "space-1", name: "Notes" }}
			>
				{null}
			</SpaceHomeShell>
		);
		const createLabels = ariaLabels(container).filter((label) =>
			label.endsWith("を作成")
		);
		expect(createLabels).toEqual([
			"空白のドキュメントを作成",
			"Space へようこそを作成",
			"最初のテーブルを作成",
			"シングルスペースを作成",
			"空白のボードを作成",
		]);
		const tabs = [...container.querySelectorAll('[role="tab"]')].map(
			(tab) => tab.textContent
		);
		expect(tabs).toEqual(["最近", "ピン留め", "共有アイテム"]);
	});

	test("an untitled document row is named in Japanese", async () => {
		const container = await renderInJapanese(
			<ul>
				<DocumentRow doc={{ chunkCount: 0, id: "doc-1", title: "" }} />
			</ul>
		);
		expect(ariaLabels(container)).toContain("無題を開く");
	});
});
