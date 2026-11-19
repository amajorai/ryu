import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const { VaultDeleteUsageWarning, VaultUsedBy } = await import(
	"./VaultSecretUsage.tsx"
);

const target = { token: "t", url: "https://usage.fixture", userJwt: null };
const originalFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | null = null;
const seen: string[] = [];

afterEach(async () => {
	globalThis.fetch = originalFetch;
	await act(async () => root?.unmount());
	root = null;
	seen.length = 0;
	document.body.replaceChildren();
});

function serve(services: string[] | null) {
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL) => {
			seen.push(String(input));
			return Promise.resolve(
				services === null
					? Response.json({ error: "denied" }, { status: 403 })
					: Response.json({ ref: "secret:API_KEY", services })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={new QueryClient()}>
				<I18nProvider initialLocale="en" initialPackId={null}>
					{node}
				</I18nProvider>
			</QueryClientProvider>
		);
	});
	// Let the usage query resolve and render.
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await act(async () => {
			await Bun.sleep(20);
		});
	}
	return container;
}

test("Used by lists the services that reference the value", async () => {
	serve(["stripe", "github"]);
	const view = await render(<VaultUsedBy name="API_KEY" target={target} />);
	expect(seen[0]).toBe(
		"https://usage.fixture/api/vault/broker/usage?ref=secret%3AAPI_KEY"
	);
	const items = [...view.querySelectorAll("li")].map((li) => li.textContent);
	expect(items).toEqual(["github", "stripe"]);
});

test("Used by says when no service uses the value, or the caller may not list them", async () => {
	serve([]);
	const empty = await render(<VaultUsedBy name="API_KEY" target={target} />);
	expect(empty.textContent).toContain("No broker service uses this value.");
	await act(async () => root?.unmount());
	serve(null);
	const denied = await render(<VaultUsedBy name="API_KEY" target={target} />);
	expect(denied.querySelectorAll("li")).toHaveLength(0);
});

test("the delete warning names the services and stays hidden when none use it", async () => {
	serve(["stripe"]);
	const warned = await render(
		<VaultDeleteUsageWarning name="API_KEY" target={target} />
	);
	expect(warned.querySelector('[role="alert"]')?.textContent).toContain(
		"Broker services use this value (stripe)"
	);
	await act(async () => root?.unmount());
	serve([]);
	const quiet = await render(
		<VaultDeleteUsageWarning name="API_KEY" target={target} />
	);
	expect(quiet.querySelector('[role="alert"]')).toBeNull();
	await act(async () => root?.unmount());
	seen.length = 0;
	await render(<VaultDeleteUsageWarning name={null} target={target} />);
	expect(seen).toHaveLength(0);
});
