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
const { StatusDot } = await import("./NodeSelector-status.tsx");

// The status dot's name is its only text: assistive tech reads the aria-label and
// sighted users see the hover title, so both must follow the UI language.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { "Checking status": "جارٍ التحقق من الحالة", Online: "متصل" },
	ja: {
		"Checking status": "状態を確認中",
		Offline: "オフライン",
		Online: "オンライン",
	},
};

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

async function renderDot(
	locale: string,
	online: boolean | null
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((tag) => CATALOGS[tag.split("-")[0]] ?? {});
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
				<StatusDot online={online} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	const dot = container.querySelector<HTMLElement>("[role='img']");
	if (!dot) {
		throw new Error("status dot did not render");
	}
	return dot;
}

test("a Japanese dot names the pending state in Japanese", async () => {
	const dot = await renderDot("ja", null);
	expect(dot.getAttribute("aria-label")).toBe("状態を確認中");
	expect(dot.getAttribute("title")).toBe("状態を確認中");
});

test("a Japanese dot names the online and offline states in Japanese", async () => {
	expect((await renderDot("ja", true)).getAttribute("aria-label")).toBe(
		"オンライン"
	);
	expect((await renderDot("ja", false)).getAttribute("aria-label")).toBe(
		"オフライン"
	);
});

test("an Arabic dot names the pending state in Arabic", async () => {
	expect((await renderDot("ar", null)).getAttribute("title")).toBe(
		"جارٍ التحقق من الحالة"
	);
});
