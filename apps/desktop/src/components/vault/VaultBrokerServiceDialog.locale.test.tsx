import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The broker's host field names a hostname. The bare word "Host" reads as the
// verb "to host" in German ("Hosten"), so the label must be "Hostname".
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
const { VaultBrokerServiceDialog } = await import(
	"./VaultBrokerServiceDialog.tsx"
);

const DE: Record<string, string> = {
	Host: "Hosten",
	Hostname: "Hostname",
	Port: "Port",
};

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

test("the broker service host field reads as a hostname in German", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const service = {
		auth: { token: "secret:STRIPE", type: "bearer" },
		createdAt: "2026-01-01T00:00:00Z",
		enabled: true,
		environment: "dev",
		host: "api.stripe.com",
		name: "stripe",
		pathPrefix: "/",
		updatedAt: "2026-01-01T00:00:00Z",
	};
	await act(async () => {
		root?.render(
			<QueryClientProvider client={new QueryClient()}>
				<I18nProvider initialLocale="de" initialPackId={null}>
					<VaultBrokerServiceDialog
						draft={{ mode: "edit", service } as never}
						onOpenChange={() => undefined}
						target={{ url: "http://127.0.0.1:1" } as never}
					/>
				</I18nProvider>
			</QueryClientProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const label = document.querySelector('label[for="broker-service-host"]');
	expect(label?.textContent?.trim()).toBe("Hostname");
	expect(document.body.textContent).not.toContain("Hosten");
});
