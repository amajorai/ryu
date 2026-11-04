import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Mermaid's parser rejects with dynamic English text the catalog cannot hold.
// The block must lead with a translated sentence and keep that text verbatim
// as a secondary detail line the DOM localizer leaves alone.
const PARSER_MESSAGE =
	"Parse error on line 2:\nExpecting 'SEMI', 'NEWLINE', got 'NODE_STRING'";
mock.module("mermaid", () => ({
	default: {
		initialize: () => undefined,
		render: () => Promise.reject(new Error(PARSER_MESSAGE)),
	},
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { MermaidBlock } = await import("./markdown-mermaid.tsx");

const DE: Record<string, string> = {
	"This diagram could not be rendered.":
		"Dieses Diagramm konnte nicht dargestellt werden.",
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
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderFailingBlock(locale: string): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
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
				<MermaidBlock
					code={"graph TD\nC D"}
					isIncomplete={false}
					language="mermaid"
					wideBlocks={false}
				/>
			</I18nProvider>
		);
	});
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (container.querySelector('[data-testid="mermaid-error-detail"]')) {
			break;
		}
		await act(async () => {
			await Bun.sleep(25);
		});
	}
	return container;
}

test("a failed chat diagram leads with a German sentence and keeps the parser detail verbatim", async () => {
	const container = await renderFailingBlock("de");
	expect(container.textContent).toContain(
		"Dieses Diagramm konnte nicht dargestellt werden."
	);
	const detail = container.querySelector(
		'[data-testid="mermaid-error-detail"]'
	);
	expect(detail?.textContent).toBe(PARSER_MESSAGE);
	expect(detail?.getAttribute("data-ryu-i18n")).toBe("off");
});

test("the lead stays English under an English runtime", async () => {
	const container = await renderFailingBlock("en");
	expect(container.textContent).toContain(
		"This diagram could not be rendered."
	);
});
