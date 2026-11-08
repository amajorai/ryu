// The forum list footer is one translated sentence per action set: German
// owns its conjunction and casing, and no lowercased English label leaks.
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ListFooter } = await import("./forum-topics.tsx");

const DE: Record<string, string> = {
	"<browse>Browse all categories</browse> or <latest>view latest topics</latest>.":
		"<browse>Alle Kategorien durchsuchen</browse> oder <latest>neueste Themen ansehen</latest>.",
	"<clear>Clear search</clear>.": "<clear>Suche löschen</clear>.",
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

async function renderFooter(
	locale: string,
	labels: string[],
	clicked: string[] = []
) {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	const actions = labels.map((label) => ({
		label,
		onClick: () => {
			clicked.push(label);
		},
	}));
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ListFooter actions={actions} message="Ende." />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const paragraph = container.querySelector("p");
	return {
		buttons: [...container.querySelectorAll("button")],
		text: paragraph?.textContent ?? "",
	};
}

test("German renders both actions in its own sentence and casing", async () => {
	const clicked: string[] = [];
	const footer = await renderFooter(
		"de",
		["Browse all categories", "View latest topics"],
		clicked
	);
	expect(footer.text).toBe(
		"Ende. Alle Kategorien durchsuchen oder neueste Themen ansehen."
	);
	expect(footer.text).not.toContain(" or ");
	expect(footer.text).not.toContain("view latest topics");
	expect(footer.buttons.map((button) => button.textContent)).toEqual([
		"Alle Kategorien durchsuchen",
		"neueste Themen ansehen",
	]);
	await act(async () => {
		footer.buttons[1]?.click();
	});
	expect(clicked).toEqual(["View latest topics"]);
});

test("German translates the single clear-search action", async () => {
	const footer = await renderFooter("de", ["Clear search"]);
	expect(footer.text).toBe("Ende. Suche löschen.");
});

test("English keeps the joined sentence", async () => {
	const footer = await renderFooter("en", [
		"Browse all categories",
		"View latest topics",
	]);
	expect(footer.text).toBe(
		"Ende. Browse all categories or view latest topics."
	);
});

test("English closes a single action with its own full stop", async () => {
	const single = await renderFooter("en", ["Browse all categories"]);
	expect(single.text).toBe("Ende. Browse all categories.");
});

test("no actions leaves only the message", async () => {
	const footer = await renderFooter("en", []);
	expect(footer.text).toBe("Ende.");
	expect(footer.buttons).toEqual([]);
});
