import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { McpLoadError } = await import("./McpSection.tsx");

// Each list failure is one whole German sentence, never a translated frame
// around an English "MCP servers"/"MCP tools" noun.
const DE: Record<string, string> = {
	"Couldn’t load MCP servers.": "MCP-Server konnten nicht geladen werden.",
	"Couldn’t load MCP tools.": "MCP-Tools konnten nicht geladen werden.",
	Retry: "Erneut versuchen",
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

async function renderLoadError(
	kind: "servers" | "tools",
	locale = "de"
): Promise<HTMLElement> {
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
				<McpLoadError
					error="GET /api/mcp/servers → 502"
					kind={kind}
					onRetry={() => undefined}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(25);
	});
	return container;
}

test("a servers load failure reads as one German sentence", async () => {
	const container = await renderLoadError("servers");
	const text = container.textContent ?? "";
	expect(text).toContain("MCP-Server konnten nicht geladen werden.");
	expect(text).not.toContain("MCP servers");
	expect(text).toContain("Erneut versuchen");
	expect(text).toContain("GET /api/mcp/servers → 502");
});

test("a tools load failure reads as one German sentence", async () => {
	const container = await renderLoadError("tools");
	const text = container.textContent ?? "";
	expect(text).toContain("MCP-Tools konnten nicht geladen werden.");
	expect(text).not.toContain("MCP tools");
});

test("English keeps the whole English sentence per kind", async () => {
	const container = await renderLoadError("tools", "en");
	expect(container.textContent).toContain("Couldn’t load MCP tools.");
});
