import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { gatewayAcpQueryOptions } = await import(
	"@/src/lib/gateway-acp-query.ts"
);
const { AcpRuntimeSection } = await import("./AcpRuntimeSection.tsx");

// The Auto option carries Core's computed limit inside one whole message, so a
// translator can reorder or reword it instead of meeting "Auto" plus " (4)".
// The DOM localizer is off so the component itself must do the translating.
const DE: Record<string, string> = {
	"Auto ({limit})": "Automatisch ({limit})",
};

const TARGET = { url: "https://acp.fixture", token: "acp-token" };
const roots: Root[] = [];

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

test("labels the Auto parallel-agent option with its limit in German", async () => {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	queryClient.setQueryData(gatewayAcpQueryOptions(TARGET).queryKey, {
		acp: {
			active_agents: 0,
			auto_max_parallel_agents: 4,
			effective_max_parallel_agents: 4,
			idle_timeout_minutes: 10,
			keep_computer_awake: false,
			max_parallel_agents: null,
		},
	} as never);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					initialPackId={null}
				>
					<AcpRuntimeSection canConfigure target={TARGET} />
				</I18nProvider>
			</QueryClientProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const trigger = container.querySelector(
		'[aria-label="Maximum parallel ACP agents"]'
	);
	expect(trigger?.textContent).toContain("Automatisch (4)");
	expect(container.textContent ?? "").not.toContain("Auto (4)");
});
