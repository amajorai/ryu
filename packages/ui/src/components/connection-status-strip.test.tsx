import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

// The desktop connection strip writes its lead as a whole sentence with its
// punctuation ("Node offline."), so the catalog translates it, and its hover
// text is the rendered (translated) sentence instead of joined English props.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ConnectionStatusToast } = await import("./connection-status.tsx");
const { StatusStrip } = await import("./connection-status-strip.tsx");
const { useTitleFromText } = await import("./connection-status-strip-title.ts");

const JA: Record<string, string> = {
	"Can’t reach {nodeName}. Reconnecting automatically…":
		"{nodeName} に接続できません。自動的に再接続しています…",
	"Node offline.": "ノードはオフラインです。",
	"Offline mode.": "オフラインモードです。",
	"Waiting for connectivity…": "接続を待機しています…",
};

const AR: Record<string, string> = {
	"Offline mode.": "وضع عدم الاتصال.",
	"Waiting for connectivity…": "في انتظار الاتصال…",
};

const LATIN_COPY = /[A-Za-z]/;

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

async function render(locale: string, node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : requested.startsWith("ar") ? AR : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

function stripText(container: HTMLElement): HTMLElement {
	const text = container.querySelector<HTMLElement>(
		'[data-slot="status-strip-text"]'
	);
	if (!text) {
		throw new Error("status strip text missing");
	}
	return text;
}

test("the unreachable strip and its hover text are Japanese under ja", async () => {
	const container = await render(
		"ja",
		<ConnectionStatusToast
			layout="strip"
			nodeName="デザイン"
			phase="node-unreachable"
		/>
	);
	const text = stripText(container);
	expect(text.textContent).toContain("ノードはオフラインです。");
	expect(text.textContent).toContain("デザイン に接続できません。");
	expect(text.textContent ?? "").not.toMatch(LATIN_COPY);
	const title = text.getAttribute("title") ?? "";
	expect(title).toContain("ノードはオフラインです。");
	expect(title).not.toMatch(LATIN_COPY);
});

test("the offline strip translates its title and detail under ja", async () => {
	const container = await render(
		"ja",
		<ConnectionStatusToast layout="strip" phase="offline" />
	);
	const text = stripText(container);
	expect(text.textContent).toStartWith("オフラインモードです。 ");
	expect(text.textContent ?? "").not.toMatch(LATIN_COPY);
	expect(text.getAttribute("title")).toBe(text.textContent);
});

test("the offline strip and its hover text are Arabic under ar", async () => {
	const container = await render(
		"ar",
		<ConnectionStatusToast layout="strip" phase="offline" />
	);
	const text = stripText(container);
	expect(text.textContent).toStartWith("وضع عدم الاتصال. ");
	expect(text.textContent ?? "").not.toMatch(LATIN_COPY);
	expect(text.getAttribute("title")).toBe(text.textContent);
});

test("English still renders the whole sentence with its full stop", async () => {
	const container = await render(
		"en",
		<ConnectionStatusToast
			layout="strip"
			nodeName="Design node"
			phase="node-unreachable"
		/>
	);
	const title = container.querySelector('[data-slot="status-strip-title"]');
	expect(title?.textContent).toBe("Node offline.");
	expect(stripText(container).getAttribute("title")).toBe(
		"Node offline. Can’t reach Design node. Reconnecting automatically…"
	);
});

test("the hover text follows the rendered text when it is rewritten in place", async () => {
	const container = await render(
		"en",
		<StatusStrip detail="Saving changes…" title="Offline." />
	);
	const text = stripText(container);
	expect(text.getAttribute("title")).toBe("Offline. Saving changes…");
	const detail = text.querySelector('[data-slot="status-strip-detail"]');
	await act(async () => {
		if (detail?.firstChild) {
			detail.firstChild.textContent = "変更を保存しています…";
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(text.getAttribute("title")).toBe("Offline. 変更を保存しています…");
});

function Labelled({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	useTitleFromText(ref);
	return <span ref={ref}>{text}</span>;
}

test("an element with no text carries no hover title", async () => {
	const container = await render("en", <Labelled text="" />);
	expect(container.querySelector("span")?.hasAttribute("title")).toBe(false);
	const filled = await render("en", <Labelled text="  Two   words " />);
	expect(filled.querySelector("span")?.getAttribute("title")).toBe("Two words");
});
