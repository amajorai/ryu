import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider, useLiteralMessages } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { summarizeSandboxSpec } = await import("./NodeSelector-sandboxes.tsx");

// The sandbox row summary formats memory with the UI's locale (read through the
// mounted provider, as the row does) and falls back to the translated noun.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { Sandbox: "بيئة معزولة" },
	ja: { Sandbox: "サンドボックス" },
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

function Summary({ memGib }: { memGib: number | null }) {
	const tl = useLiteralMessages();
	return (
		<span>
			{summarizeSandboxSpec({ gpu: null, memGib, os: null, vcpu: null }, tl)}
		</span>
	);
}

async function renderSummary(
	locale: string,
	memGib: number | null
): Promise<string> {
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
				<Summary memGib={memGib} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container.textContent ?? "";
}

test("a German row groups memory with the locale's separator", async () => {
	expect(await renderSummary("de", 1536)).toBe("1.536 GiB");
});

test("an Egyptian Arabic row formats memory in Arabic-Indic digits", async () => {
	expect(await renderSummary("ar-EG", 1536)).toBe("١٬٥٣٦ GiB");
});

test("a Japanese row with nothing reported shows the translated noun", async () => {
	expect(await renderSummary("ja", null)).toBe("サンドボックス");
});
