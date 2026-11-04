import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Mermaid needs a layout engine happy-dom lacks; stand in with a parser failure
// whose message is the dynamic English text Mermaid really produces.
const PARSER_MESSAGE =
	"Parse error on line 3:\nExpecting 'SEMI', 'NEWLINE', got 'NODE_STRING'";
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
const { MermaidBody } = await import("./ArtifactRenderer-views.tsx");

const JA: Record<string, string> = {
	"This diagram could not be rendered.": "この図を表示できませんでした。",
	"Rendering diagram…": "図を表示しています…",
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

async function renderFailingDiagram(locale: string): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
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
				<MermaidBody
					artifact={{
						content: "graph TD\nA-->B\nC D",
						id: "diagram-1",
						kind: "mermaid",
						sourceMessageId: "message-1",
						title: "Flow",
					}}
					theme={undefined}
				/>
			</I18nProvider>
		);
	});
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (container.querySelector('[data-testid="artifact-error-detail"]')) {
			break;
		}
		await act(async () => {
			await Bun.sleep(25);
		});
	}
	return container;
}

test("a Mermaid parse failure leads with a Japanese sentence and keeps the parser detail verbatim", async () => {
	const container = await renderFailingDiagram("ja");
	expect(container.textContent).toContain("この図を表示できませんでした。");
	const detail = container.querySelector(
		'[data-testid="artifact-error-detail"]'
	);
	expect(detail?.textContent).toBe(PARSER_MESSAGE);
	expect(detail?.getAttribute("data-ryu-i18n")).toBe("off");
});

test("the English lead stays English under an English runtime", async () => {
	const container = await renderFailingDiagram("en");
	expect(container.textContent).toContain(
		"This diagram could not be rendered."
	);
	expect(
		container.querySelector('[data-testid="artifact-error-detail"]')
			?.textContent
	).toBe(PARSER_MESSAGE);
});
