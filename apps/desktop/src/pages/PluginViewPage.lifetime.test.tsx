import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Keep the real HTTP transport while Happy DOM supplies React's DOM surface.
const transport = {
	fetch: globalThis.fetch,
	Response: globalThis.Response,
	AbortController: globalThis.AbortController,
};
if (!globalThis.document) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, transport);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let node = { url: "", token: "", userJwt: "", name: "Node" };
let views = [
	{
		plugin: "com.test.view",
		id: "list",
		title: "View",
		approved_grants: ["ui:declarative-http"],
		spec: {
			view: "list-detail",
			items: [],
			source: { http: { path: "/api/ext/com.test.view/items" } },
		},
	},
];
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => node,
}));
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useTabSelector: () => () => undefined,
}));
mock.module("@ryu/ui/hooks/use-confirm-dialog.tsx", () => ({
	useConfirmDialog: () => ({ confirm: async () => true }),
}));
mock.module("@/src/hooks/usePluginContributions.ts", () => ({
	usePluginContributions: () => ({ views }),
}));
mock.module("@/src/lib/api/client.ts", () => ({
	toTarget: (target: typeof node) => target,
	apiUrl: (target: typeof node, path: string) => target.url + path,
	requestHeaders: async () => ({}),
}));
mock.module("@/src/lib/api/plugins.ts", () => ({
	pluginHostInvoke: async () => undefined,
}));
const { default: PluginViewPage } = await import("./PluginViewPage.tsx");

async function waitFor(condition: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!condition() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("closing a plugin view releases its pending HTTP response body", async () => {
	let started = 0;
	let closed = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			started += 1;
			request.signal.addEventListener("abort", () => {
				closed += 1;
			});
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("["));
					},
				}),
				{ headers: { "Content-Type": "application/json" } }
			);
		},
	});
	node = { ...node, url: server.url.origin };
	const client = new QueryClient();
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<PluginViewPage pluginId="com.test.view" viewId="list" />
				</QueryClientProvider>
			);
		});
		await waitFor(() => started === 1);
		expect(started).toBe(1);
		await act(async () => root.render(null));
		await waitFor(() => closed === 1);
		expect(closed).toBe(1);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		await server.stop(true);
	}
});

test("cosmetic view and node updates retain the read while credentials and grants still apply", async () => {
	let reads = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			reads += 1;
			return Response.json([{ id: "row", title: `Read ${reads}` }]);
		},
	});
	node = { ...node, url: server.url.origin };
	const client = new QueryClient();
	const container = document.createElement("div");
	const root = createRoot(container);
	const render = () => {
		root.render(
			<QueryClientProvider client={client}>
				<PluginViewPage pluginId="com.test.view" viewId="list" />
			</QueryClientProvider>
		);
	};
	try {
		await act(async () => {
			render();
		});
		await act(async () => waitFor(() => reads === 1));
		expect(reads).toBe(1);
		views = [{ ...views[0], title: "Renamed view" }];
		node = { ...node, name: "Renamed node" };
		await act(async () => {
			render();
		});
		await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
		expect(container.textContent).toContain("Renamed view");
		expect(reads).toBe(1);
		node = { ...node, userJwt: "changed-test-scope" };
		await act(async () => {
			render();
		});
		await act(async () => waitFor(() => reads >= 2));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
		expect(reads).toBe(2);
		expect(container.textContent).toContain("Read 2");
		views = [{ ...views[0], approved_grants: [] }];
		await act(async () => {
			render();
		});
		expect(container.textContent).not.toContain("Read 2");
		expect(reads).toBe(2);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		await server.stop(true);
	}
});
