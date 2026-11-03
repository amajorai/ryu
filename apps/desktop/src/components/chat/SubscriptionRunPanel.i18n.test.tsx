import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
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
const { SUBSCRIPTION_RUN_QUERY_KEY, SubscriptionRunPanel } = await import(
	"./SubscriptionRunPanel.tsx"
);

// The DOM localizer skips a <pre>'s own attributes, so the run log and the
// changes panel must carry their accessible names in the UI language.
const DE: Record<string, string> = {
	Changes: "Änderungen",
	"Run log": "Laufprotokoll",
	"View changes": "Änderungen ansehen",
};

const URL = "http://core.test";
const CONVERSATION = "conv-1";
const FEATURES = {
	diffInRyu: true,
	followUp: false,
	liveScreen: false,
	liveStatus: false,
	pullRequestInRyu: false,
	runLog: true,
	ryuCredits: false,
	stopFromRyu: false,
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("the run log and changes panels are named in the UI language", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
	});
	queryClient.setQueryData([SUBSCRIPTION_RUN_QUERY_KEY, URL, CONVERSATION], {
		accountId: "acct",
		backend: "anthropic-subscription-cli",
		branch: null,
		conversationId: CONVERSATION,
		createdAt: 0,
		environmentId: "env",
		executor: "local",
		externalId: null,
		features: FEATURES,
		lastError: null,
		outputTail: "building…",
		status: "done",
		summary: null,
		updatedAt: 0,
		url: null,
	});
	queryClient.setQueryData(
		[SUBSCRIPTION_RUN_QUERY_KEY, "diff", URL, CONVERSATION],
		{ branch: null, files: ["a.ts"], patch: "+one", truncated: false }
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<I18nProvider initialLocale="de" initialPackId={null}>
					<SubscriptionRunPanel
						conversationId={CONVERSATION}
						target={{ token: null, url: URL }}
					/>
				</I18nProvider>
			</QueryClientProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const toggle = container.querySelector("button[aria-expanded]");
	await act(async () => {
		toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	const labels = [...container.querySelectorAll("pre")].map((pre) =>
		pre.getAttribute("aria-label")
	);
	expect(labels).toEqual(["Laufprotokoll", "Änderungen"]);
	await act(async () => root.unmount());
	container.remove();
});
