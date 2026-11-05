// The embedding strategy's "Similarity threshold" slider reads its value in the
// reader's number format: "0,75" under German, not the ASCII "0.75" a
// hand-written toFixed shows.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { EntitlementProvider } = await import(
	"@/src/contexts/entitlement-context.tsx"
);
const { useAgentAutoDialog } = await import(
	"@/src/store/useAgentAutoDialog.ts"
);
const { AgentAutoRoutingEditor } = await import("./AgentAutoRoutingEditor.tsx");

/** The node answers the agent-auto preference with the embedding strategy. */
const SAVED_CONFIG = {
	classifier_model: "",
	default_agent_id: "ryu",
	embedding_model: "",
	enabled: true,
	rules: [],
	similarity_threshold: 0.75,
	strategy: "embedding",
};
const realFetch = globalThis.fetch;
function stubNode(): void {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/api/preferences/")) {
				return Promise.resolve(
					Response.json({ value: JSON.stringify(SAVED_CONFIG) })
				);
			}
			return Promise.resolve(
				Response.json({ error: "not found" }, { status: 404 })
			);
		},
		{ preconnect: realFetch.preconnect }
	);
}

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			useAgentAutoDialog.getState().setOpen(false);
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
	globalThis.fetch = realFetch;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderEditor(locale: string): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	stubNode();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () => {
		useAgentAutoDialog.getState().setOpen(true);
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<QueryClientProvider client={queryClient}>
					<EntitlementProvider>
						<AgentAutoRoutingEditor />
					</EntitlementProvider>
				</QueryClientProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return document.body.textContent ?? "";
}

test("the similarity threshold readout uses a German decimal comma", async () => {
	const text = await renderEditor("de");
	expect(text).toContain("Similarity threshold");
	expect(text).toContain("0,75");
	expect(text).not.toContain("0.75");
});

test("the similarity threshold readout keeps the English decimal point", async () => {
	expect(await renderEditor("en")).toContain("0.75");
});
