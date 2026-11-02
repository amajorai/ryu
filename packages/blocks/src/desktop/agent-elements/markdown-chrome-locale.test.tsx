import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The Markdown wrapper is `data-ryu-i18n="off"` so the DOM localizer never
// rewrites the model's prose. Its chrome (code-block, table and Mermaid
// controls, the omitted-image placeholder) must therefore translate itself.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Markdown, MarkdownResponseImages, preloadMarkdown } = await import(
	"./markdown.tsx"
);
const { MermaidBlock } = await import("./markdown-mermaid.tsx");

await preloadMarkdown();

const DE: Record<string, string> = {
	Copy: "Kopieren",
	"Copy code": "Code kopieren",
	"Copy diagram": "Diagramm kopieren",
	"Copy table": "Tabelle kopieren",
	"Download file": "Datei herunterladen",
	"Expand diagram": "Diagramm erweitern",
	"Expand table": "Tabelle erweitern",
	"Image omitted": "Bild ausgelassen",
	"Open Mermaid diagram": "Mermaid-Diagramm öffnen",
	"Rendering…": "Wird gerendert…",
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

async function renderIn(locale: string, node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
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

function attr(container: HTMLElement, selector: string, name: string) {
	return container.querySelector(selector)?.getAttribute(name) ?? null;
}

const REPLY = [
	"```ts",
	"const answer = 42;",
	"```",
	"",
	"| a | b |",
	"| - | - |",
	"| 1 | 2 |",
	"",
	"![](https://example.com/chart.png)",
].join("\n");

function Reply() {
	return (
		<MarkdownResponseImages.Provider value={false}>
			<Markdown content={REPLY} />
		</MarkdownResponseImages.Provider>
	);
}

test("code-block, table and image chrome translate under a German runtime", async () => {
	const container = await renderIn("de", <Reply />);
	expect(container.querySelector('[data-ryu-i18n="off"]')).not.toBeNull();
	expect(
		attr(container, '[data-streamdown="code-block-copy-button"]', "title")
	).toBe("Code kopieren");
	expect(
		attr(container, '[data-streamdown="code-block-download-button"]', "title")
	).toBe("Datei herunterladen");
	expect(
		attr(container, '[data-testid="markdown-table-copy"]', "aria-label")
	).toBe("Tabelle kopieren");
	expect(
		container.querySelector('[data-testid="markdown-table-copy"]')?.textContent
	).toContain("Kopieren");
	expect(
		attr(container, '[data-testid="markdown-table-expand"]', "aria-label")
	).toBe("Tabelle erweitern");
	expect(
		attr(container, '[data-testid="markdown-table-expand"]', "title")
	).toBe("Tabelle erweitern");
	expect(container.textContent).toContain("Bild ausgelassen");
});

test("the same reply stays English under an English runtime", async () => {
	const container = await renderIn("en", <Reply />);
	expect(
		attr(container, '[data-streamdown="code-block-copy-button"]', "title")
	).toBe("Copy code");
	expect(
		attr(container, '[data-testid="markdown-table-expand"]', "aria-label")
	).toBe("Expand table");
	expect(container.textContent).toContain("Image omitted");
});

test("the Mermaid toolbar translates while the diagram renders", async () => {
	const container = await renderIn(
		"de",
		<MermaidBlock
			code="graph TD; A-->B"
			isIncomplete={true}
			language="mermaid"
			wideBlocks={false}
		/>
	);
	expect(container.textContent).toContain("Wird gerendert…");
	expect(container.textContent).not.toContain("Rendering…");
});

test("the Mermaid toolbar translates once the diagram renders", async () => {
	// The real renderer needs a layout engine happy-dom lacks; stand in for it.
	mock.module("mermaid", () => ({
		default: {
			initialize: () => undefined,
			render: () => Promise.resolve({ svg: "<svg></svg>" }),
		},
	}));
	const container = await renderIn(
		"de",
		<MermaidBlock
			code="graph TD; A-->B"
			isIncomplete={false}
			language="mermaid"
			wideBlocks={false}
		/>
	);
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (container.querySelector('[data-testid="mermaid-copy"]')) {
			break;
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
	}
	expect(attr(container, '[data-testid="mermaid-copy"]', "aria-label")).toBe(
		"Diagramm kopieren"
	);
	expect(attr(container, '[data-testid="mermaid-expand"]', "aria-label")).toBe(
		"Diagramm erweitern"
	);
	expect(
		attr(container, "button[aria-label]:not([data-testid])", "aria-label")
	).toBe("Mermaid-Diagramm öffnen");
});
