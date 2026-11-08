// The Store's apps and plugins tabs title their load-failure, no-results and
// no-selection states with whole sentences per tab. The English noun used to be
// passed into "Couldn't load {nounPlural}" as an argument, so a Japanese reader
// saw "appsを読み込めませんでした": the catalog translated the frame and kept the
// English word. These tests render those states with no DOM localizer to rescue
// them and assert no English noun survives.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
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
const { CatalogHostProvider } = await import("./host.tsx");
const { AppList } = await import("./apps-catalog-section-app-list.tsx");
const { AppDetailPanel } = await import(
	"./apps-catalog-section-detail-panel.tsx"
);
const { VARIANT_COPY } = await import("./apps-catalog-section-variant-copy.ts");
const { REALM_ICONS } = await import("./realm-icons.ts");

const JA: Record<string, string> = {
	"Couldn't load apps": "アプリを読み込めませんでした",
	"Couldn't load plugins": "プラグインを読み込めませんでした",
	"No apps found": "アプリが見つかりません",
	"No plugins found": "プラグインが見つかりません",
	"No app selected": "アプリが選択されていません",
	"No plugin selected": "プラグインが選択されていません",
	"Pick an app from the list to read what it does, review its permissions, and install it.":
		"一覧からアプリを選ぶと、機能と権限を確認してインストールできます。",
	"Pick a plugin from the list to read what it does, review its permissions, and install it.":
		"一覧からプラグインを選ぶと、機能と権限を確認してインストールできます。",
};

const HOST = {
	ActiveModelControl: () => null,
	install: null,
	Markdown: ({ content }: { content: string }) => <p>{content}</p>,
	openExternal: () => undefined,
	renderAffordance: () => null,
	useActiveNode: () => ({ token: null, url: "" }),
	useInterfaceLevel: () => "expert",
};

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function renderInJapanese(node: ReactNode): Promise<string> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
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
				<CatalogHostProvider host={HOST as never}>{node}</CatalogHostProvider>
			</I18nProvider>
		);
		await Bun.sleep(50);
	});
	return mount.textContent ?? "";
}

type Variant = keyof typeof VARIANT_COPY;

function appList(variant: Variant, error: string | null) {
	const noop = () => undefined;
	return (
		<AppList
			canInstall={false}
			communityFetchNextPage={noop}
			communityHasNextPage={false}
			communityInstallError={null}
			communityInstallingId={null}
			communityItems={[]}
			communityLoadedCount={0}
			communityLoading={false}
			communitySelectedId={null}
			error={error}
			fallbackIcon={REALM_ICONS[variant === "plugins" ? "plugins" : "apps"]}
			fetchNextPage={noop}
			hasNextPage={false}
			isInstalling={() => false}
			items={[]}
			loadedCount={0}
			loading={false}
			loadingMore={false}
			onClearSearch={noop}
			onDisable={noop}
			onInstall={noop}
			onInstallCommunity={noop}
			onRetry={noop}
			onSelect={noop}
			onSelectCommunity={noop}
			searching
			selectedId={null}
			settingsOpener={() => null}
			variantCopy={VARIANT_COPY[variant]}
		/>
	);
}

function emptyDetail(variant: Variant) {
	return (
		<AppDetailPanel
			detail={null}
			detailError={null}
			detailLoading={false}
			error={null}
			install={() => Promise.resolve()}
			installLayer={null}
			isInstalling={() => false}
			item={null}
			lifecyclePending={false}
			renderAffordance={() => null}
			selectedId={null}
			setEnabled={() => Promise.resolve()}
			settingsOpener={() => null}
			variantCopy={VARIANT_COPY[variant]}
		/>
	);
}

/** The English nouns that used to leak into the translated frame. */
const ENGLISH_NOUN = /\b(?:apps?|plugins?)\b/u;

describe("VARIANT_COPY", () => {
	test("every variant states each message whole, with no noun argument", () => {
		const identity = (source: string) => source;
		for (const copy of Object.values(VARIANT_COPY)) {
			for (const message of [
				copy.loadError(identity),
				copy.emptySearch(identity),
				copy.noneSelected(identity),
				copy.pickHint(identity),
			]) {
				expect(message).not.toContain("{");
				expect(JA[message]).toBeDefined();
			}
		}
		expect(VARIANT_COPY.apps.pickHint(identity)).toStartWith("Pick an app ");
		expect(VARIANT_COPY.all.emptySearch(identity)).toBe("No plugins found");
	});
});

describe("Store catalog states in Japanese", () => {
	for (const variant of ["apps", "plugins"] as const) {
		const noun = variant === "apps" ? "アプリ" : "プラグイン";

		test(`${variant}: the load-failure title`, async () => {
			const copy = await renderInJapanese(appList(variant, "offline"));
			expect(copy).toContain(`${noun}を読み込めませんでした`);
			expect(copy.replace("offline", "")).not.toMatch(ENGLISH_NOUN);
		});

		test(`${variant}: the no-results title`, async () => {
			const copy = await renderInJapanese(appList(variant, null));
			expect(copy).toContain(`${noun}が見つかりません`);
			expect(copy).not.toMatch(ENGLISH_NOUN);
		});

		test(`${variant}: the no-selection detail pane`, async () => {
			const copy = await renderInJapanese(emptyDetail(variant));
			expect(copy).toContain(`${noun}が選択されていません`);
			expect(copy).toContain(`一覧から${noun}を選ぶと`);
			expect(copy).not.toMatch(ENGLISH_NOUN);
		});
	}
});
