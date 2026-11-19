import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const node = { url: "http://node.test", token: "node-token", userJwt: null };
const roster = [
	{ id: "@ryu/meetings", name: "Meetings", enabled: true },
	{ id: "@ryu/whiteboard", name: "Whiteboard", enabled: true },
	{ id: "@ryu/canvas", name: "Canvas", enabled: true },
];
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));

// Keep the real refusal parser and describers; only the transport is stubbed.
const plugins = await import("@/src/lib/api/plugins.ts");
const { parseLifecycleError } = await import(
	"@/src/lib/api/plugins-lifecycle-errors.ts"
);
let refusal: () => Response = () => Response.json({}, { status: 500 });
async function refuse(): Promise<never> {
	const err = await parseLifecycleError(refusal(), "/api/plugins/x/disable");
	throw Object.assign(new Error(err.message), err);
}
mock.module("@/src/lib/api/plugins.ts", () => ({
	...plugins,
	fetchApps: () => Promise.resolve(roster),
	disableApp: refuse,
	enableApp: refuse,
	installApp: refuse,
	uninstallApp: refuse,
}));
mock.module("@/src/lib/core-refresh.ts", () => ({
	triggerGlobalRefresh: () => undefined,
}));

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
mock.module("@/src/lib/query-client.ts", () => ({ queryClient }));
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { useApps } = await import("./useApps.ts");

// Stub ja strings: the generated catalog does not carry these translations yet.
const JA: Record<string, string> = {
	"You don't have permission ({permission}) to change apps on this node.":
		"このノードのアプリを変更する権限（{permission}）がありません。",
	"{plugin} is needed by {names}. Disable {names} first.":
		"{plugin} は {names} に必要です。先に {names} を無効にしてください。",
};

let latest: ReturnType<typeof useApps> | null = null;
function Reader() {
	latest = useApps();
	return <output>{latest.toggleError}</output>;
}

const container = document.createElement("div");
let root = createRoot(container);
afterEach(async () => {
	await act(async () => root.unmount());
	registerLiteralCatalogLoader(null);
	queryClient.clear();
	latest = null;
	root = createRoot(container);
});

async function mountInJapanese(): Promise<ReturnType<typeof useApps>> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	await act(async () =>
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<QueryClientProvider client={queryClient}>
					<Reader />
				</QueryClientProvider>
			</I18nProvider>
		)
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	if (!latest) {
		throw new Error("useApps did not render");
	}
	return latest;
}

test("a node permission refusal on toggle and uninstall renders in Japanese", async () => {
	refusal = () =>
		Response.json(
			{
				error: "app_lifecycle_permission_denied",
				required_permission: "apps:manage",
			},
			{ status: 403 }
		);
	const expected =
		"このノードのアプリを変更する権限（apps:manage）がありません。";
	const apps = await mountInJapanese();
	await act(async () => {
		expect(await apps.toggle("@ryu/meetings", false)).toEqual({
			error: expected,
			success: false,
		});
	});
	expect(container.textContent).toBe(expected);

	await act(async () => apps.clearToggleError());
	await act(async () => latest?.uninstall("@ryu/meetings"));
	expect(container.textContent).toBe(expected);
});

test("a blocked disable lists the dependents with the Japanese separator", async () => {
	refusal = () =>
		Response.json(
			{
				dependency_error: {
					code: "blocked_by_dependents",
					dependents: ["@ryu/whiteboard", "@ryu/canvas"],
					plugin: "@ryu/meetings",
				},
			},
			{ status: 409 }
		);
	const apps = await mountInJapanese();
	await act(async () => {
		await apps.toggle("@ryu/meetings", false);
	});
	expect(container.textContent).toBe(
		"Meetings は Whiteboard、Canvas に必要です。先に Whiteboard、Canvas を無効にしてください。"
	);
});
