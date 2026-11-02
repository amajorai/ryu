// The model detail's device-fit copy under a non-English UI: the "Your device"
// lines and the blocked-install notice must read entirely in the UI language,
// never Core's English `fit_label` or hand-built English unit lines.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
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
const { FitInstallNotice } = await import(
	"./models-catalog-section-install-notice.tsx"
);
const { ModelOverviewGrid } = await import(
	"./models-catalog-section-detail-header.tsx"
);

const JA: Record<string, string> = {
	"Too large for your device's memory": "デバイスのメモリに対して大きすぎます",
	"Not enough free disk space to download it":
		"ダウンロードに必要な空き容量が足りません",
	"{verdictLabel}. This device has {ramHuman} of unified memory.":
		"{verdictLabel}。このデバイスのユニファイドメモリは {ramHuman} です。",
	"{verdictLabel}. Only {diskFreeHuman} is free on the models drive.":
		"{verdictLabel}。モデル用ドライブの空き容量は {diskFreeHuman} しかありません。",
	"{ram} unified memory": "ユニファイドメモリ {ram}",
	"{diskFree} free disk": "空きディスク {diskFree}",
	"{vram} GPU RAM": "GPU RAM {vram}",
	"{ram} system RAM": "システム RAM {ram}",
};

const UNIFIED_DEVICE = {
	diskFreeHuman: "1.2 GB",
	gpuName: null,
	os: "macos",
	ramHuman: "36 GB",
	unifiedMemory: true,
	vramBytes: null,
	vramHuman: "",
};

const CARD = {
	architecture: null,
	author: "google",
	compatible: true,
	contextLength: 32_768,
	createdAt: "2026-01-01T00:00:00Z",
	downloads: 1,
	format: "gguf" as const,
	gated: false,
	id: "google/gemma-4b",
	installed: false,
	lastModified: "2026-06-01T00:00:00Z",
	likes: 1,
	name: "Gemma-4B-Instruct",
	needsEngine: null,
	params: 4_000_000_000,
	pipelineTag: "text-generation",
	tags: [],
};

const roots: Root[] = [];

async function renderJa(node: ReactNode): Promise<string> {
	registerLiteralCatalogLoader(() => JA);
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
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
	return mount.textContent ?? "";
}

afterEach(async () => {
	// Unmounting the provider unregisters its runtime, so "ja" does not leak.
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("model device-fit copy under ja", () => {
	test("words a too_big block in Japanese, ignoring Core's English label", async () => {
		const text = await renderJa(
			<FitInstallNotice
				device={UNIFIED_DEVICE}
				fit="too_big"
				label="Too large for your device's memory"
			/>
		);
		expect(text).toContain("デバイスのメモリに対して大きすぎます。");
		expect(text).not.toContain("Too large for your device's memory");
	});

	test("words a no_space block in Japanese", async () => {
		const text = await renderJa(
			<FitInstallNotice
				device={UNIFIED_DEVICE}
				fit="no_space"
				label="Not enough free disk space to download it"
			/>
		);
		expect(text).toContain("モデル用ドライブの空き容量は 1.2 GB");
		expect(text).not.toContain("Not enough free disk space");
	});

	test("lists the device's memory and disk in Japanese", async () => {
		const text = await renderJa(
			<ModelOverviewGrid card={CARD} device={UNIFIED_DEVICE} />
		);
		expect(text).toContain("ユニファイドメモリ 36 GB");
		expect(text).toContain("空きディスク 1.2 GB");
		expect(text).not.toContain("36 GB unified memory");
		expect(text).not.toContain("1.2 GB free disk");
	});
});
