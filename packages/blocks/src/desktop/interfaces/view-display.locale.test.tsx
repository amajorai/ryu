// The board's Display menu and the knowledge graph's Display section are the
// view options (zh-CN "显示", ja "表示") and read through the keyed
// `view.display`. The bare catalog "Display" is a monitor (zh-CN "显示器").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { BoardDisplayMenu } = await import("./board-display.tsx");
const { KnowledgeControls } = await import("./knowledge-controls.tsx");
const { DEFAULT_SETTINGS } = await import("./knowledge-model-settings.ts");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Stand-in for the monitor sense of the bare catalog row. */
const OVERLAYS = { "zh-CN": { Display: "显示器" } };

function render(locale: string, node: ReactNode): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			{node}
		</I18nProvider>
	);
}

const boardMenu = (
	<BoardDisplayMenu
		groupBy="status"
		onGroupByChange={() => undefined}
		onViewChange={() => undefined}
		view="list"
	/>
);

const knowledge = (
	<KnowledgeControls
		hasSelection={false}
		onAnimate={() => undefined}
		onChange={() => undefined}
		onClose={() => undefined}
		onPick={() => undefined}
		onQueryChange={() => undefined}
		onQuerySubmit={() => undefined}
		onReset={() => undefined}
		query=""
		results={[]}
		searchRef={createRef<HTMLInputElement>()}
		settings={DEFAULT_SETTINGS}
		topicCount={0}
	/>
);

test("the Chinese board menu names the view options 显示, not a monitor", () => {
	const html = render("zh-CN", boardMenu);
	expect(html).toContain('aria-label="显示"');
	expect(html).toContain(">显示</span>");
	expect(html).not.toContain("显示器");
});

test("the Japanese knowledge graph names its Display section 表示", () => {
	const html = render("ja", knowledge);
	expect(html).toContain(">表示<");
});

test("the Chinese knowledge graph section is not a monitor", () => {
	expect(render("zh-CN", knowledge)).not.toContain("显示器");
});

test("English keeps Display on both", () => {
	expect(render("en", boardMenu)).toContain(">Display</span>");
	expect(render("en", knowledge)).toContain(">Display<");
});
