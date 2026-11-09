import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { OverflowRow } = await import("./cowork-rows.tsx");

type OverflowKind = Parameters<typeof OverflowRow>[0]["kind"];
type Root = ReturnType<typeof createRoot>;

const mounted: Root[] = [];

const FILES = "{count, plural, one {+# more file} other {+# more files}}";
const STEPS = "{count, plural, one {+# more step} other {+# more steps}}";
const SIDE_CHATS =
	"{count, plural, one {+# more side chat} other {+# more side chats}}";
const SUBAGENTS =
	"{count, plural, one {+# more subagent} other {+# more subagents}}";

// Stub catalogs: the shipped catalog has no entries for these messages yet.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		[SUBAGENTS]:
			"{count, plural, zero {لا وكلاء آخرين} one {+وكيل آخر} two {+وكيلان آخران} few {+# وكلاء آخرين} many {+# وكيلًا آخر} other {+# وكيل آخر}}",
	},
	de: {
		[STEPS]:
			"{count, plural, one {+# weiterer Schritt} other {+# weitere Schritte}}",
		[SIDE_CHATS]:
			"{count, plural, one {+# weiterer Nebenchat} other {+# weitere Nebenchats}}",
	},
	ja: {
		[FILES]: "{count, plural, other {+他#件のファイル}}",
		"View all": "すべて表示",
	},
};

async function mount(
	locale: string,
	kind: OverflowKind,
	count: number,
	onShowAll?: () => void
): Promise<HTMLDivElement> {
	registerLiteralCatalogLoader(
		(requested) =>
			CATALOGS[
				Object.keys(CATALOGS).find((key) => requested.startsWith(key)) ?? ""
			] ?? {}
	);
	const container = document.createElement("div");
	if (locale === "ar") {
		container.setAttribute("dir", "rtl");
	}
	document.body.append(container);
	const root = createRoot(container);
	mounted.push(root);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ul>
					<OverflowRow count={count} kind={kind} onShowAll={onShowAll} />
				</ul>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return container;
}

afterEach(() => {
	for (const root of mounted.splice(0)) {
		act(() => root.unmount());
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("English renders the whole overflow sentence with the right plural", async () => {
	expect((await mount("en", "files", 1)).textContent).toBe("+1 more file");
	document.body.innerHTML = "";
	expect((await mount("en", "sideChats", 4)).textContent).toBe(
		"+4 more side chats"
	);
});

test("Japanese renders the overflow as one sentence with no English noun", async () => {
	const container = await mount("ja", "files", 3, () => undefined);
	const text = container.textContent ?? "";
	expect(text).toContain("+他3件のファイル");
	expect(text).toContain("すべて表示");
	expect(text).not.toMatch(/more|files?\b|View all/);
});

test("German picks the singular form for one hidden row", async () => {
	expect((await mount("de", "steps", 1)).textContent).toBe(
		"+1 weiterer Schritt"
	);
	document.body.innerHTML = "";
	expect((await mount("de", "sideChats", 5)).textContent).toBe(
		"+5 weitere Nebenchats"
	);
});

test("Arabic picks the dual and many plural forms", async () => {
	const dual = (await mount("ar", "subagents", 2)).textContent ?? "";
	expect(dual).toContain("وكيلان آخران");
	document.body.innerHTML = "";
	const many = (await mount("ar", "subagents", 11)).textContent ?? "";
	expect(many).toContain("+11 وكيلًا آخر");
	expect(many).not.toContain("subagent");
});
