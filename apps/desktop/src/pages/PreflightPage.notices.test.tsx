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
const { gatewayRestartNotice } = await import("./PreflightPage.notices.ts");

const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		"Gateway can't be restarted from here":
			"لا يمكن إعادة تشغيل Gateway من هنا",
		"Restarting Gateway…": "جارٍ إعادة تشغيل Gateway…",
	},
	ja: {
		"Gateway can't be restarted from here":
			"ここから Gateway を再起動することはできません",
		"Restarting Gateway…": "Gateway を再起動しています…",
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

function Probe({ ok }: { ok: boolean }) {
	const notice = gatewayRestartNotice(ok, useLiteralMessages());
	return <output data-tone={notice.tone}>{notice.message}</output>;
}

async function renderNotice(
	locale: string,
	ok: boolean
): Promise<{ message: string; tone: string | null }> {
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
				<Probe ok={ok} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	const output = container.querySelector("output");
	return {
		message: output?.textContent ?? "",
		tone: output?.getAttribute("data-tone") ?? null,
	};
}

test("a sent Gateway restart is an info toast in Japanese", async () => {
	expect(await renderNotice("ja", true)).toEqual({
		message: "Gateway を再起動しています…",
		tone: "info",
	});
});

test("a refused Gateway restart is a warning toast in Japanese and Arabic", async () => {
	expect(await renderNotice("ja", false)).toEqual({
		message: "ここから Gateway を再起動することはできません",
		tone: "warning",
	});
	expect((await renderNotice("ar", false)).message).toBe(
		"لا يمكن إعادة تشغيل Gateway من هنا"
	);
});

test("English keeps both source sentences", async () => {
	expect((await renderNotice("en", true)).message).toBe("Restarting Gateway…");
	expect((await renderNotice("en", false)).message).toBe(
		"Gateway can't be restarted from here"
	);
});
