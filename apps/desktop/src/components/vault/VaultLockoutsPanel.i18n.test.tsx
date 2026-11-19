import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Root } from "react-dom/client";
import {
	button,
	click,
	flush,
	installAnimationApis,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The lockouts panel in Japanese against a loopback node: the save toast comes
// from the translator. The DOM localizer is off, so a toast title that skipped
// `tl` would render here as English.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "lockouts-i18n-token";
let config = {
	enabled: true,
	threshold: 5,
	windowSecs: 900,
	durationSecs: 900,
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const route = `${request.method} ${new URL(request.url).pathname}`;
		if (route === "GET /api/vault/sys/lockouts") {
			return NativeResponse.json({ config, locked: [] });
		}
		if (route === "PUT /api/vault/sys/lockouts/config") {
			config = await request.json();
			return NativeResponse.json({ config });
		}
		return NativeResponse.json(
			{ error: `undeclared ${route}` },
			{ status: 404 }
		);
	},
});
const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

const SAVED_EN = "Lockout settings saved";
const SAVE_EN = "Save";
const JA: Record<string, string> = {
	[SAVED_EN]: "ロックアウト設定を保存しました",
	[SAVE_EN]: "保存",
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { VaultLockoutsPanel } = await import("./VaultLockoutsPanel.tsx");
installAnimationApis();

let root: Root | null = null;

afterEach(async () => {
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

test("the save toast reads in the chosen language", async () => {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
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
					initialLocale="ja"
					initialPackId={null}
				>
					<Toaster />
					<VaultLockoutsPanel target={target} />
				</I18nProvider>
			</QueryClientProvider>
		)
	);
	await flush(4);
	const input = document.getElementById(
		"vault-lockout-threshold"
	) as HTMLInputElement | null;
	if (!input) {
		throw new Error(`No threshold input: ${text()}`);
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(input, "3");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await flush(2);
	const save =
		[...document.querySelectorAll("button")].find(
			(item) => item.textContent === JA[SAVE_EN]
		) ?? button(SAVE_EN);
	await click(save);
	await until(() => text().includes(JA[SAVED_EN] ?? ""), "saved toast");
	expect(config.threshold).toBe(3);
	expect(text()).not.toContain(SAVED_EN);
});
