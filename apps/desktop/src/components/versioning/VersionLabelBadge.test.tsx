import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { VersionLabelBadge } = await import("./VersionLabelBadge.tsx");

const JA: Record<string, string> = {
	"Agent saved": "エージェントを保存しました",
	"Before restore": "復元前",
	"Release v2": "リリース v2",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

async function renderLabels(labels: string[]): Promise<string[]> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				{labels.map((label) => (
					<VersionLabelBadge key={label} label={label} />
				))}
			</I18nProvider>
		);
	});
	const badges = [...container.querySelectorAll('[data-ryu-i18n="off"]')].map(
		(badge) => badge.textContent ?? ""
	);
	await act(async () => {
		root.unmount();
	});
	return badges;
}

test("Core's automatic labels render in Japanese and a user label stays as typed", async () => {
	expect(
		await renderLabels(["Agent saved", "Before restore", "Release v2"])
	).toEqual(["エージェントを保存しました", "復元前", "Release v2"]);
});
