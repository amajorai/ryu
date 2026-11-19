import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Root } from "react-dom/client";
import {
	flush,
	installAnimationApis,
	registerDomWithNativeNetworking,
	text,
	until,
} from "../settings/unswept-a.test-support.ts";

// Pending change requests in Japanese against a loopback node: the request
// line names the change and the requester through the translator. The DOM
// localizer is off, so a word that skipped `tl` shows up here as English.
setDefaultTimeout(20_000);
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
registerDomWithNativeNetworking();

const TOKEN = "change-requests-i18n-token";

function changeRequest(id: string, requestedBy: string) {
	return {
		approvals: [],
		coords: {
			environment: "prod",
			name: `SECRET_${id}`,
			path: "/",
			scope: "user",
			scopeId: "user-1",
		},
		decidedAt: null,
		decidedBy: null,
		hasValue: true,
		id,
		operation: "write",
		patch: null,
		reason: null,
		requestedAt: "not a date",
		requestedBy,
		requiredApprovals: 2,
		status: "pending",
	};
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/api/vault/change-requests") {
			return NativeResponse.json({
				changeRequests: [
					changeRequest("mine", "user-me"),
					changeRequest("theirs", "ada"),
				],
			});
		}
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});
const target = {
	token: TOKEN,
	url: `http://127.0.0.1:${server.port}`,
	userJwt: null,
};

const JA: Record<string, string> = {
	"New value": "新しい値",
	"Requested by you": "あなたがリクエスト",
	"Requested by {name}": "{name} がリクエスト",
};

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { VaultChangeRequests } = await import("./VaultChangeRequests.tsx");
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

test("the request line names the change and requester in Japanese", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
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
					<VaultChangeRequests callerSubject="user-me" target={target} />
				</I18nProvider>
			</QueryClientProvider>
		)
	);
	await until(() => text().includes("SECRET_theirs"), "requests listed");
	await flush(2);
	const body = text();
	expect(body).toContain("新しい値 · prod");
	expect(body).toContain("あなたがリクエスト");
	expect(body).toContain("ada がリクエスト");
	expect(body).not.toContain("New value");
	expect(body).not.toContain(" you ");
});
