import { afterEach, expect, test } from "bun:test";
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
const { installCatalogEntry, ORG_INSTALL_BLOCK_COPY } = await import(
	"./catalog-entry-install.ts"
);

import type { CatalogEntry } from "@/src/lib/api/plugins.ts";

// The install refusals are thrown from a plain module, outside React, and the
// Store and the chat install card show the thrown message as-is. They must come
// out in the UI language of the mounted provider.
const JA: Record<string, string> = {
	[ORG_INSTALL_BLOCK_COPY.marketplace]:
		"組織の管理者により Marketplace プラグインは無効になっています。",
	[ORG_INSTALL_BLOCK_COPY.apps]:
		"組織の管理者によりアプリのインストールは無効になっています。",
	"Community listings are browse-only — open the repository to review it before installing.":
		"コミュニティの掲載は閲覧専用です。インストールする前にリポジトリを開いて確認してください。",
};

// Every case here refuses before any request, so the target is never dialled.
const target = { url: "http://127.0.0.1:9", token: "fixture-node" };

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function mountLocale(locale: string): Promise<void> {
	registerLiteralCatalogLoader((tag) => (tag.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<span />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function entry(
	overrides: Partial<CatalogEntry> & { id: string }
): CatalogEntry {
	return {
		description: "",
		kinds: ["plugin"],
		name: overrides.id,
		tags: [],
		version: "1.0.0",
		...overrides,
	} as CatalogEntry;
}

test("the producers' English org refusals are the table's sentences", () => {
	expect(ORG_INSTALL_BLOCK_COPY.marketplace).toBe(
		"Marketplace plugins are disabled by your organization's administrator."
	);
	expect(ORG_INSTALL_BLOCK_COPY.apps).toBe(
		"App installation is disabled by your organization's administrator."
	);
});

test("a Japanese UI throws the organization block in Japanese", async () => {
	await mountLocale("ja");
	await expect(
		installCatalogEntry(target, entry({ id: "acme-plugin" }), {
			installed: false,
			orgInstallBlock: () => ORG_INSTALL_BLOCK_COPY.marketplace,
		})
	).rejects.toThrow(
		"組織の管理者により Marketplace プラグインは無効になっています。"
	);
	await expect(
		installCatalogEntry(
			target,
			entry({ id: "@ryu/mail", source: "built-in" }),
			{
				installed: false,
				orgInstallBlock: () => ORG_INSTALL_BLOCK_COPY.apps,
			}
		)
	).rejects.toThrow(
		"組織の管理者によりアプリのインストールは無効になっています。"
	);
});

test("a Japanese UI throws the community browse-only refusal in Japanese", async () => {
	await mountLocale("ja");
	await expect(
		installCatalogEntry(
			target,
			entry({ id: "gh:someone/x", origin: "community" }),
			{ installed: false, orgInstallBlock: () => null }
		)
	).rejects.toThrow("コミュニティの掲載は閲覧専用です。");
});

test("an English UI keeps the organization block in English", async () => {
	await mountLocale("en");
	await expect(
		installCatalogEntry(target, entry({ id: "acme-plugin" }), {
			installed: false,
			orgInstallBlock: () => ORG_INSTALL_BLOCK_COPY.marketplace,
		})
	).rejects.toThrow(ORG_INSTALL_BLOCK_COPY.marketplace);
});
