// The booklet's page controls translate their own labels and tooltips, and the
// tooltip names the arrow key that pages in the current reading direction.
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { PassportPageNav } = await import("./passport-page-nav.tsx");

const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		"Next page": "الصفحة التالية",
		"Next page (←)": "الصفحة التالية (←)",
		"Next page (→)": "الصفحة التالية (→)",
		Pages: "الصفحات",
		"Previous page": "الصفحة السابقة",
		"Previous page (←)": "الصفحة السابقة (←)",
		"Previous page (→)": "الصفحة السابقة (→)",
	},
	de: {
		"Next page": "Nächste Seite",
		"Next page (→)": "Nächste Seite (→)",
		Pages: "Seiten",
		"Previous page": "Vorherige Seite",
		"Previous page (←)": "Vorherige Seite (←)",
	},
	ja: {
		"Next page": "次のページ",
		"Next page (→)": "次のページ (→)",
		Pages: "ページ",
		"Previous page": "前のページ",
		"Previous page (←)": "前のページ (←)",
	},
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

async function renderNav(locale: string, direction: "ltr" | "rtl") {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.slice(0, 2)] ?? {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<DirectionProvider direction={direction}>
					<PassportPageNav
						canNext
						canPrevious
						caption="2–3"
						next={() => undefined}
						previous={() => undefined}
					/>
				</DirectionProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const buttons = [...container.querySelectorAll("button")];
	return {
		labels: buttons.map((button) => button.getAttribute("aria-label")),
		nav: container.querySelector("nav")?.getAttribute("aria-label"),
		titles: buttons.map((button) => button.getAttribute("title")),
	};
}

test("Arabic swaps the arrow keys and translates the tooltips", async () => {
	const nav = await renderNav("ar", "rtl");
	expect(nav.nav).toBe("الصفحات");
	expect(nav.labels).toEqual(["الصفحة السابقة", "الصفحة التالية"]);
	expect(nav.titles).toEqual(["الصفحة السابقة (→)", "الصفحة التالية (←)"]);
});

test("Japanese keeps the left-to-right arrow keys", async () => {
	const ja = await renderNav("ja", "ltr");
	expect(ja.nav).toBe("ページ");
	expect(ja.titles).toEqual(["前のページ (←)", "次のページ (→)"]);
});

test("German keeps the left-to-right arrow keys", async () => {
	const de = await renderNav("de", "ltr");
	expect(de.labels).toEqual(["Vorherige Seite", "Nächste Seite"]);
	expect(de.titles).toEqual(["Vorherige Seite (←)", "Nächste Seite (→)"]);
});

test("English is unchanged in left-to-right reading", async () => {
	const nav = await renderNav("en", "ltr");
	expect(nav.nav).toBe("Pages");
	expect(nav.titles).toEqual(["Previous page (←)", "Next page (→)"]);
});
