import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import type { Root } from "react-dom/client";
import {
	click,
	flush,
	installAnimationApis,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// The syncs panel in Arabic and Japanese against a loopback node: the folder
// arrows point along the reading direction, and the toasts come from the
// translator. The DOM localizer is off so a literal that skipped `tl` (and so
// never reached the catalog) shows up here as English.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "syncs-i18n-token";

const STORE = {
	address: "https://vault.example.test",
	authMethod: "token",
	createdAt: 1,
	id: "xs_1",
	kind: "openbao",
	mount: "secret",
	name: "bao",
	pathPrefix: "",
	projectId: "",
	updatedAt: 1,
};

const SYNC = {
	dirty: false,
	environment: "prod",
	failures: 0,
	id: "xdst_1",
	intervalSecs: 3600,
	lastCount: 2,
	lastError: null,
	lastPushAt: 5,
	lastStatus: "ok",
	path: "/web",
	remotePath: "",
	storeId: "xs_1",
};

const SOURCE = {
	environment: "prod",
	id: "xsrc_1",
	lastCount: 3,
	lastError: null,
	lastStatus: "ok",
	lastSyncAt: 5,
	mode: "sync",
	path: "/shared",
	remotePath: "shared",
	storeId: "xs_1",
	syncIntervalSecs: 3600,
};

let destinations: (typeof SYNC)[] = [];

function json(body: unknown, status = 200): Response {
	return NativeResponse.json(body, { status });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
			return json({ error: "Unauthorized" }, 401);
		}
		switch (route) {
			case "GET /api/vault/external/stores":
				return json({ stores: [STORE] });
			case "GET /api/vault/external/destinations":
				return json({ destinations });
			case "GET /api/vault/external/sources":
				return json({ sources: [SOURCE] });
			case "DELETE /api/vault/external/destinations/xdst_1":
				destinations = [];
				return json({ deleted: true });
			// A refusal without a reason: the panel supplies its own sentence.
			case "POST /api/vault/external/stores/xs_1/test":
				return json({ ok: false });
			default:
				return json({ error: `undeclared ${route}` }, 404);
		}
	},
});
const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

const REMOVED_EN = "Sync removed; values already pushed stay in place";
const REFUSED_EN = "The store refused the credentials";
const FAILED_EN = "That did not work";

const JA: Record<string, string> = {
	[FAILED_EN]: "うまくいきませんでした",
	[REFUSED_EN]: "ストアが認証情報を拒否しました",
	[REMOVED_EN]: "同期を削除しました。送信済みの値はそのまま残ります",
};

const AR: Record<string, string> = {
	[REMOVED_EN]: "أُزيلت المزامنة؛ تبقى القيم التي دُفعت في مكانها",
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { VaultSyncsPanel } = await import("./VaultSyncsPanel.tsx");
installAnimationApis();

let root: Root | null = null;

// Row actions in the order they render; their names follow the locale.
function rowButton(label: string, index: number): HTMLButtonElement {
	const row = [...document.querySelectorAll("li")].find((item) =>
		item.textContent?.includes(label)
	);
	const found = row?.querySelectorAll("button")[index];
	if (!found) {
		throw new Error(`No button ${index} in row ${label}: ${text()}`);
	}
	return found;
}

async function mount(locale: "ar" | "ja"): Promise<void> {
	registerLiteralCatalogLoader((requested) => {
		if (requested.startsWith("ja")) {
			return JA;
		}
		return requested.startsWith("ar") ? AR : {};
	});
	document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
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
					initialLocale={locale}
					initialPackId={null}
				>
					<Toaster />
					<VaultSyncsPanel environment="prod" target={target} />
				</I18nProvider>
			</QueryClientProvider>
		)
	);
	await flush(4);
}

beforeEach(() => {
	destinations = [{ ...SYNC }];
});

afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await act(async () => root?.unmount());
	root = null;
	document.documentElement.removeAttribute("dir");
	document.body.replaceChildren();
});

afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

test("right-to-left rows use mirrored arrow icons, not fixed arrow glyphs", async () => {
	await mount("ar");
	await until(
		() => text().includes("prod:/web") && text().includes("prod:/shared"),
		"sync and source rows"
	);
	const arrows = document.querySelectorAll("li svg[data-directional-icon]");
	expect(arrows.length).toBe(2);
	for (const arrow of arrows) {
		expect(arrow.getAttribute("class")).toContain("rtl:-scale-x-100");
		expect(arrow.getAttribute("aria-hidden")).toBe("true");
	}
	expect(text()).not.toContain("→");
	expect(text()).not.toContain("←");
});

test("the remove-sync toast is translated", async () => {
	await mount("ar");
	await until(() => text().includes("prod:/web"), "sync row");
	await click(rowButton("prod:/web", 1));
	await until(() => text().includes(AR[REMOVED_EN] ?? ""), "removed toast");
	expect(text()).not.toContain(REMOVED_EN);
});

test("a test refusal without a reason reads in the chosen language", async () => {
	await mount("ja");
	await until(() => text().includes("bao"), "target row");
	await click(rowButton("openbao", 0));
	await until(() => text().includes(JA[REFUSED_EN] ?? ""), "refusal toast");
	expect(text()).toContain(JA[FAILED_EN] ?? "");
	expect(text()).not.toContain(REFUSED_EN);
	expect(text()).not.toContain(FAILED_EN);
});
