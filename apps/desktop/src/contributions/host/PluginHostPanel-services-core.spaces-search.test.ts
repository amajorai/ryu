import { afterAll, beforeEach, expect, test } from "bun:test";
import { dispatchRpc } from "@ryu/app-host/rpc";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { buildPluginHostCoreServices } from "./PluginHostPanel-services-core.ts";

// An app's spaces.search must go through Core's governed host bridge, which
// limits hits to the app's own app:<pluginId> documents. A host-direct call to
// the public Space search route under the node token would return every
// document in the Space (security sweep finding RB-3).

const requests: Array<{ path: string; body: unknown }> = [];
const ownMatch = {
	chunk_id: "chunk-own",
	content: "the app's own note",
	distance: 0.25,
	document_id: "doc-own",
};
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		const body: unknown = await request.json().catch(() => null);
		requests.push({ path, body });
		if (path.includes("com.example.broken")) {
			return Response.json({ result: { matches: [{ chunk_id: 7 }] } });
		}
		if (path.endsWith("/host")) {
			return Response.json({
				result: {
					matches: [{ ...ownMatch, metadata: { ordinal: 0 } }],
					space_id: "space-1",
				},
			});
		}
		// The public route answers as an unfiltered Space search would.
		return Response.json({
			matches: [
				ownMatch,
				{
					chunk_id: "chunk-user",
					content: "the user's private meeting notes",
					distance: 0.3,
					document_id: "doc-user",
				},
			],
		});
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	requests.length = 0;
});

const node = {
	url: `${server.url.toString().replace(/\/$/, "")}/node`,
	token: "fixture-node-token",
	userJwt: null,
};
const context = {
	assistantContextRef: { current: [] },
	assistantOwner: "plugin:com.example.notes",
	assistantSurfaceRef: { current: null },
	companion: { pluginId: "com.example.notes" },
	fileAccess: undefined,
	getActiveNode: () => node,
	i18n: { locale: "en" },
	isActiveTabRef: { current: true },
	node,
	onRequestClose: undefined,
	toastHost: {},
} as unknown as PluginHostServicesContext;
const services = buildPluginHostCoreServices(context);
const input = { limit: 5, query: "notes", space_id: "space-1" };

test("spacesSearch asks Core's host bridge under the host-owned plugin id", async () => {
	const result = await services.spacesSearch?.(input);
	expect(result).toEqual([ownMatch]);
	expect(requests).toEqual([
		{
			path: "/node/api/plugins/com.example.notes/host",
			body: { method: "spaces.search", args: input },
		},
	]);
});

test("the spaces.search RPC never reaches the public Space search route", async () => {
	const result = await dispatchRpc(
		"spaces.search",
		[input],
		new Set(["spaces.docs"]),
		services
	);
	expect(result).toEqual([ownMatch]);
	expect(requests.map(({ path }) => path)).toEqual([
		"/node/api/plugins/com.example.notes/host",
	]);
	expect(
		requests.some(({ path }) => path.includes("/api/spaces/space-1/search"))
	).toBe(false);
});

test("a malformed bridge reply is refused instead of passed to the frame", async () => {
	const broken = buildPluginHostCoreServices({
		...context,
		companion: { pluginId: "com.example.broken" },
	} as unknown as PluginHostServicesContext);
	await expect(
		broken.spacesSearch?.({ query: "notes", space_id: "space-1" })
	).rejects.toThrow();
	expect(requests.map(({ path }) => path)).toEqual([
		"/node/api/plugins/com.example.broken/host",
	]);
});
