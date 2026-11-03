import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { WebMcpPageTool } from "./webmcp.ts";

// The page-tool form's subtitle falls back to "Current page" when a tool has
// no origin. That fallback must follow the UI language, while a real origin
// (a URL the page declared) is shown verbatim.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { PageToolForm } = await import("./page-tools-form.tsx");

function shippedCatalog(locale: string): Record<string, string> {
	const url = new URL(`../../i18n/locales/${locale}.json`, import.meta.url)
		.pathname;
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, string>;
}

const noop = () => undefined;
const baseTool: WebMcpPageTool = {
	id: "local\u0000read_page\u00000",
	description: "Read the current page.",
	inputSchema: {
		additionalProperties: false,
		properties: {},
		type: "object",
	},
	name: "read_page",
	title: "Read a page",
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

interface Rendered {
	/** The subtitle's tooltip, which no DOM text localizer rewrites. */
	subtitleTitle: string | null;
	text: string;
}

async function renderIn(locale: string, node: ReactNode): Promise<Rendered> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? shippedCatalog(locale) : {}
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
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return {
		subtitleTitle:
			container.querySelector("p[title]")?.getAttribute("title") ?? null,
		text: container.textContent ?? "",
	};
}

describe("page-tool form origin label", () => {
	for (const locale of ["ar", "ja", "de"]) {
		test(`translates the missing-origin fallback in ${locale}`, async () => {
			const expected = shippedCatalog(locale)["Current page"];
			expect(expected).toBeTruthy();
			expect(expected).not.toBe("Current page");

			const { subtitleTitle, text } = await renderIn(
				locale,
				<PageToolForm
					onBack={noop}
					onExecute={async () => "ok"}
					onResult={noop}
					tool={baseTool}
				/>
			);

			expect(subtitleTitle).toBe(`read_page · ${expected}`);
			expect(text).toContain(`read_page · ${expected}`);
			expect(text).not.toContain("Current page");
		});
	}

	test("shows a declared origin verbatim", async () => {
		const { subtitleTitle, text } = await renderIn(
			"ar",
			<PageToolForm
				onBack={noop}
				onExecute={async () => "ok"}
				onResult={noop}
				tool={{ ...baseTool, origin: "https://example.com" }}
			/>
		);

		expect(subtitleTitle).toBe("read_page · https://example.com");
		expect(text).toContain("read_page · https://example.com");
	});
});
