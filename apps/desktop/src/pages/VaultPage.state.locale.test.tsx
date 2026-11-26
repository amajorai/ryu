import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	mock,
	setDefaultTimeout,
	test,
} from "bun:test";
import { join } from "node:path";
import type { Root } from "react-dom/client";
import {
	button,
	click,
	flush,
	installAnimationApis,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../components/settings/unswept-a.test-support.ts";

// The Vault page's restore toasts read in the active locale: the success
// title, and on a bare 500 the failure title with its "Try again." fallback.
// The DOM localizer is off, so only `tl` can translate them; the German text
// is the shipped catalog's own.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const CATALOG = (await Bun.file(
	join(import.meta.dir, "../../../../packages/i18n/locales/de.json")
).json()) as Record<string, string>;
const KEYS = ["Could not restore", "Try again.", "Vault secret restored"];
const DE: Record<string, string> = Object.fromEntries(
	KEYS.map((key) => [key, CATALOG[key] ?? ""])
);

const TOKEN = "vault-page-state-node";
let refuse = false;
let writes: string[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (request.method === "GET") {
			return NativeResponse.json({ error: "undeclared" }, { status: 404 });
		}
		writes.push(`${request.method} ${url.pathname}`);
		return refuse
			? NativeResponse.json({}, { status: 500 })
			: NativeResponse.json({ ok: true });
	},
});
const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
mock.module("@/src/hooks/useVaultChangeStream.ts", () => ({
	useVaultChangeStream: () => undefined,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useVaultPageState } = await import("./VaultPage.state.ts");
installAnimationApis();

const SECRET = {
	environment: "prod",
	name: "API_KEY",
	path: "/",
	scope: "user",
	scopeId: "user-1",
} as never;

function RestoreHarness() {
	const { restoreMutation } = useVaultPageState();
	return (
		<button onClick={() => restoreMutation.mutate(SECRET)} type="button">
			Restore API_KEY
		</button>
	);
}

let root: Root | null = null;

async function mount(): Promise<void> {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root?.render(
			<QueryClientProvider client={client}>
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					initialPackId={null}
				>
					<Toaster />
					<RestoreHarness />
				</I18nProvider>
			</QueryClientProvider>
		)
	);
	await flush(6);
}

beforeEach(() => {
	refuse = false;
	writes = [];
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
});

afterEach(async () => {
	sileo.clear();
	registerLiteralCatalogLoader(null);
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

test("the fixture strings are the shipped German catalog's", () => {
	for (const key of KEYS) {
		expect(DE[key]).toBeTruthy();
		expect(DE[key]).not.toBe(key);
	}
});

test("restoring a secret toasts in German, success and failure", async () => {
	await mount();
	await click(button("Restore API_KEY"));
	await until(
		() => text().includes(DE["Vault secret restored"] ?? "-"),
		"restored toast"
	);
	expect(writes).toEqual(["POST /api/vault/secrets/API_KEY/restore"]);
	expect(text()).not.toContain("Vault secret restored");
	sileo.clear();
	refuse = true;
	await click(button("Restore API_KEY"));
	await until(
		() => text().includes(DE["Could not restore"] ?? "-"),
		"failure toast"
	);
	await until(() => text().includes(DE["Try again."] ?? "-"), "description");
	expect(text()).not.toContain("Could not restore");
	expect(text()).not.toContain("Try again.");
});
