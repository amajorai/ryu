// A phone visitor who sends themselves the download link must get the message
// in their UI language: the share sheet title and text, and the WhatsApp,
// Telegram, SMS and email links all carry the translated sentence.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register({ url: "https://ryu.test/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { DownloadSendDrawer } = await import("./download-send-drawer.tsx");

const JA_TEXT = "パソコンでRyuをダウンロード：";
const JA_TITLE = "Ryuをダウンロード";
const JA: Record<string, string> = {
	"Download Ryu": JA_TITLE,
	"Download Ryu on your computer:": JA_TEXT,
};
const URL = "https://ryu.test/download";

interface SharePayload {
	text?: string;
	title?: string;
	url?: string;
}

let mounted: { container: HTMLElement; root: Root } | undefined;
const shared: SharePayload[] = [];

afterEach(async () => {
	registerLiteralCatalogLoader(null);
	Reflect.deleteProperty(navigator, "share");
	shared.length = 0;
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
	document.body.replaceChildren();
});

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderDrawer(locale: string) {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	Object.defineProperty(navigator, "share", {
		configurable: true,
		value: (payload: SharePayload) => {
			shared.push(payload);
			return Promise.resolve();
		},
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<DownloadSendDrawer
					onOpenChange={() => undefined}
					open
					siteOrigin="https://ryu.test"
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

function hrefOf(target: string): string {
	return (
		document
			.querySelector<HTMLAnchorElement>(`[data-share-target="${target}"]`)
			?.getAttribute("href") ?? ""
	);
}

async function tapShare() {
	const button =
		document.querySelector<HTMLButtonElement>("[data-send-action]");
	if (!button) {
		throw new Error("The drawer shows no share button.");
	}
	await act(async () => {
		button.click();
		await Promise.resolve();
	});
}

describe("DownloadSendDrawer share copy", () => {
	test("sends the Japanese sentence through every share link", async () => {
		await renderDrawer("ja");
		const text = encodeURIComponent(JA_TEXT);
		const message = encodeURIComponent(`${JA_TEXT} ${URL}`);
		expect(hrefOf("whatsapp")).toBe(`https://wa.me/?text=${message}`);
		expect(hrefOf("telegram")).toBe(
			`https://t.me/share/url?url=${encodeURIComponent(URL)}&text=${text}`
		);
		expect(hrefOf("messages")).toEndWith(`body=${message}`);
		expect(hrefOf("email")).toBe(
			`mailto:?subject=${encodeURIComponent(JA_TITLE)}&body=${message}`
		);
	});

	test("hands the Japanese title and text to the system share sheet", async () => {
		await renderDrawer("ja");
		await tapShare();
		expect(shared).toEqual([{ text: JA_TEXT, title: JA_TITLE, url: URL }]);
	});

	test("keeps the English copy in English", async () => {
		await renderDrawer("en");
		expect(hrefOf("whatsapp")).toBe(
			`https://wa.me/?text=${encodeURIComponent(`Download Ryu on your computer: ${URL}`)}`
		);
		await tapShare();
		expect(shared).toEqual([
			{
				text: "Download Ryu on your computer:",
				title: "Download Ryu",
				url: URL,
			},
		]);
	});
});
