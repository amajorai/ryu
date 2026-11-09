import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { MentionSources } from "@/src/lib/mentions/types.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { buildMentionGroups } = await import("@/src/lib/mentions/candidates.ts");
const { MentionMenu } = await import("./MentionMenu.tsx");

// The "@" menu's section headings are catalog copy, resolved when the groups
// are built, so they read in the UI language instead of English. The menu
// renders under `data-ryu-i18n="off"` so the DOM localizer cannot mask a miss.
const JA: Record<string, string> = {
	Agents: "エージェント",
	"App items": "アプリの項目",
	"Personality profiles": "パーソナリティプロファイル",
	"Space pages": "スペースのページ",
};

const SOURCES: MentionSources = {
	agents: [{ id: "agent-1", name: "Ada" }],
	appItems: [{ id: "item-1", name: "Quarterly brief" }],
	apps: [],
	chats: [],
	folders: [],
	integrations: [],
	mcp: [],
	outputStyles: [{ id: "style-1", name: "Concise" }],
	pages: [{ id: "page-1", name: "Roadmap" }],
	plugins: [],
	skills: [],
	spaces: [],
	teams: [],
	users: [],
	workflows: [],
};

function Harness({ onGroups }: { onGroups: (labels: string[]) => void }) {
	const groups = buildMentionGroups(SOURCES, "");
	onGroups(groups.map((group) => group.label));
	return (
		<MentionMenu
			anchorRef={createRef<HTMLElement>()}
			groups={groups}
			onDismiss={() => undefined}
			onSelect={() => undefined}
		/>
	);
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("mention group headings render in Japanese, with no English heading", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let labels: string[] = [];
	const render = () =>
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<div data-ryu-i18n="off">
					<Harness
						onGroups={(next) => {
							labels = next;
						}}
					/>
				</div>
			</I18nProvider>
		);
	await act(async () => render());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	// Re-render once the catalog is loaded, as a keystroke in the composer would.
	await act(async () => render());

	expect(labels).toEqual([
		"エージェント",
		"アプリの項目",
		"スペースのページ",
		"パーソナリティプロファイル",
	]);
	const text = container.textContent ?? "";
	expect(text).toContain("アプリの項目");
	expect(text).toContain("スペースのページ");
	expect(text).not.toContain("App items");
	expect(text).not.toContain("Space pages");
	expect(text).not.toContain("Personality profiles");
	await act(async () => root.unmount());
	container.remove();
});
