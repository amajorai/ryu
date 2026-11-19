import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { RecordsNav } = await import("./records-nav.tsx");
const { TicketsViewsPanel } = await import("./tickets-views.tsx");
const { TicketsTabs } = await import("./tickets-tabs.tsx");
const { PanelsSidebar } = await import("./panels-parts.tsx");
const { PageHeader } = await import("./wiki-interface-page-header.tsx");
const { deskSectionLabel } = await import("./interface-renderer.ts");

// The catalog's bare "Views" is the play/view count (再生数); the headings
// over saved filters are their own string.
const JA: Record<string, string> = {
	"Page tabs": "ページタブ",
	"Saved views": "ビュー",
	Sections: "セクション",
	Views: "再生数",
};

interface Mounted {
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}

async function mountInJapanese(node: ReactNode): Promise<Mounted> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return {
		container,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

const noop = () => undefined;

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

describe("saved-view headings in Japanese", () => {
	test("the Records rail heads its saved filters as views, not view counts", async () => {
		const { container, unmount } = await mountInJapanese(
			<RecordsNav
				activeViewId={null}
				counts={{ agents: 0, projects: 0, teams: 0 }}
				loading={false}
				object="agents"
				onSelectObject={noop}
				onSelectView={noop}
				viewCounts={{}}
			/>
		);
		const headings = [...container.querySelectorAll("h3")].map(
			(heading) => heading.textContent
		);
		expect(headings).toContain("ビュー");
		expect(container.textContent).not.toContain("再生数");
		await unmount();
	});

	test("the Tickets views panel and its tab say ビュー", async () => {
		const counts = {
			all: 0,
			open: 0,
			pending: 0,
			recent: 0,
			solved: 0,
			unsolved: 0,
			urgent: 0,
		};
		const { container, unmount } = await mountInJapanese(
			<>
				<TicketsViewsPanel
					counts={counts}
					loading
					onSelect={noop}
					selectedId="open"
				/>
				<TicketsTabs
					activeId={null}
					compact={false}
					composing={false}
					draftCurrent={false}
					onCloseDraft={noop}
					onCloseTab={noop}
					onNewTicket={noop}
					onOpenTab={noop}
					onShowDraft={noop}
					onShowViews={noop}
					tabs={[]}
					viewsCurrent
				/>
			</>
		);
		expect(container.querySelector("h2")?.textContent).toBe("ビュー");
		const tab = container.querySelector(
			'[data-testid="tickets-tabs"] button[aria-current="page"]'
		);
		expect(tab?.textContent).toBe("ビュー");
		expect(container.textContent).not.toContain("再生数");
		await unmount();
	});

	test("the Panels switcher and the wiki page tabs get their own names", async () => {
		const { container, unmount } = await mountInJapanese(
			<>
				<PanelsSidebar
					activeThreadId={null}
					onNewChat={noop}
					onOpenThread={noop}
					onSelectView={noop}
					recent={[]}
					view="home"
				/>
				<PageHeader
					heading="Ada"
					headingRef={{ current: null }}
					leftTabs={[]}
					rightTabs={[
						{ id: "read", label: "Read", onSelect: noop, selected: true },
					]}
					tagline={false}
				/>
			</>
		);
		const navNames = [...container.querySelectorAll("nav")].map((nav) =>
			nav.getAttribute("aria-label")
		);
		expect(navNames).toContain("セクション");
		expect(navNames).toContain("ページタブ");
		expect(navNames).not.toContain("再生数");
		await unmount();
	});

	test("the desk's shared section is labelled with the saved-views string", () => {
		const tl = (source: string) => JA[source] ?? source;
		expect(deskSectionLabel("views", tl)).toBe("ビュー");
	});
});
