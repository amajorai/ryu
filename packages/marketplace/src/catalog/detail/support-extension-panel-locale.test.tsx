// A Store listing's "Extends" and "Where it lives" lists under a Japanese UI:
// the group headings and each feature word translate before the words are
// joined, and the version snapshot's README fact is a whole message with a
// localized byte size.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { SupportExtensionPanel } = await import("./support-extension-panel.tsx");
const { VersionSnapshotRow } = await import("./versions-panel.tsx");

const JA: Record<string, string> = {
	"Shared Ryu shell": "Ryu 共有シェル",
	"Core runtime": "Core ランタイム",
	"Package sidecar": "パッケージのサイドカー",
	"host-rendered views": "ホスト描画ビュー",
	"settings tabs": "設定タブ",
	"companion UI": "コンパニオン UI",
	"capability broker": "機能ブローカー",
	"tool runnable": "ツールの実行単位",
	"{name} process": "{name} プロセス",
	"README: {size}": "README: {size}",
	"No README at this tag": "このタグには README がありません",
};

const roots: Root[] = [];

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
	registerLiteralCatalogLoader(() => JA);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				{node}
			</I18nProvider>
		);
	});
	return host;
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

const ENTRY = {
	description: "Browser",
	id: "@ryu/browser",
	kinds: ["tool"],
	name: "Browser",
	tags: [],
	version: "1.0.0",
};

describe("SupportExtensionPanel under ja", () => {
	test("translates group headings and each feature word", async () => {
		const host = await mount(
			<SupportExtensionPanel
				detail={{
					extensions: [
						{
							features: ["host-rendered views", "settings tabs"],
							label: "Shared Ryu shell",
							target: "ryu-shell",
						},
					],
					implementation: [
						{
							features: [
								"tool runnable",
								"capability broker",
								"browser.control",
							],
							label: "Core runtime",
							layer: "core",
						},
						{
							features: ["indexer process"],
							label: "Package sidecar",
							layer: "sidecar",
						},
					],
				}}
				entry={ENTRY}
			/>
		);
		const extensions =
			host.querySelector("[data-testid='surface-extensions']")?.textContent ??
			"";
		const implementation =
			host.querySelector("[data-testid='surface-implementation']")
				?.textContent ?? "";
		expect(extensions).toContain("Ryu 共有シェル");
		expect(extensions).toContain("ホスト描画ビュー · 設定タブ");
		expect(implementation).toContain("Core ランタイム");
		expect(implementation).toContain(
			"ツールの実行単位 · 機能ブローカー · browser.control"
		);
		expect(implementation).toContain("パッケージのサイドカー");
		expect(implementation).toContain("indexer プロセス");
		expect(`${extensions}${implementation}`).not.toMatch(
			/host-rendered|capability broker|runnable|Shared Ryu shell/u
		);
	});
});

describe("VersionSnapshotRow under ja", () => {
	async function openSnapshot(readme: string | undefined) {
		const host = await mount(
			<VersionSnapshotRow
				fetchVersionDetail={() =>
					Promise.resolve({ readme, stability: "stable" })
				}
				tag="v1.0.0"
			/>
		);
		await act(async () => {
			host.querySelector("button")?.click();
			await Promise.resolve();
		});
		return host.textContent ?? "";
	}

	test("the README size is a localized byte size", async () => {
		const text = await openSnapshot("x".repeat(2048));
		expect(text).toContain("README: 2");
		expect(text).not.toContain("k chars");
	});

	test("a tag without a README reads in Japanese", async () => {
		const text = await openSnapshot(undefined);
		expect(text).toContain("このタグには README がありません");
		expect(text).not.toContain("No README at this tag");
	});
});
