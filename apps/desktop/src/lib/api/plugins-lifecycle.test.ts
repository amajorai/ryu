import { expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	disableApp,
	enableApp,
	installApp,
	installPluginFromCatalogAtVersion,
	setPluginGrants,
	uninstallApp,
	updateInstalledPlugin,
	updateInstalledPluginAtVersion,
} from "./plugins.ts";

const target = { token: "node-token", url: "http://127.0.0.1:7980" };
const scopedId = "@ryu/spaces";
const app = {
	approved_grants: [],
	created_at: null,
	enabled: true,
	id: scopedId,
	updated_at: null,
	version: "1.0.0",
};

test("plugin lifecycle routes encode scoped ids as one path segment", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<{ method: string; url: string }> = [];
	globalThis.fetch = createFetchFixture(originalFetch, async (input, init) => {
		const url = String(input);
		requests.push({ method: init?.method ?? "GET", url });
		const body = url.endsWith("/grants")
			? { approved_grants: [] }
			: url.includes("/uninstall")
				? { removed: scopedId, success: true }
				: { app };
		return Response.json(body);
	});

	try {
		await installApp(target, scopedId);
		await updateInstalledPlugin(target, scopedId);
		await enableApp(target, scopedId);
		await setPluginGrants(target, scopedId, []);
		await disableApp(target, scopedId, { cascade: true });
		await uninstallApp(target, scopedId, { cascade: true });
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(requests).toEqual([
		{
			method: "POST",
			url: `${target.url}/api/plugins/%40ryu%2Fspaces/install`,
		},
		{ method: "POST", url: `${target.url}/api/plugins/%40ryu%2Fspaces/update` },
		{ method: "POST", url: `${target.url}/api/plugins/%40ryu%2Fspaces/enable` },
		{ method: "POST", url: `${target.url}/api/plugins/%40ryu%2Fspaces/grants` },
		{
			method: "POST",
			url: `${target.url}/api/plugins/%40ryu%2Fspaces/disable?cascade=true`,
		},
		{
			method: "POST",
			url: `${target.url}/api/plugins/%40ryu%2Fspaces/uninstall?cascade=true`,
		},
	]);
});

test("historical plugin actions forward the exact version", async () => {
	const originalFetch = globalThis.fetch;
	const bodies: unknown[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json({ app });
	});

	try {
		await installPluginFromCatalogAtVersion(
			target,
			scopedId,
			"v0.9.0",
			"buyer-token"
		);
		await updateInstalledPluginAtVersion(target, scopedId, "v0.8.0");
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(bodies).toEqual([
		{ id: scopedId, version: "v0.9.0" },
		{ force: true, version: "v0.8.0" },
	]);
});

test("uninstall keeps app storage unless deleteStorage is requested", async () => {
	const originalFetch = globalThis.fetch;
	const bodies: Array<string | null> = [];
	globalThis.fetch = createFetchFixture(originalFetch, async (_input, init) => {
		bodies.push(typeof init?.body === "string" ? init.body : null);
		return Response.json({ removed: scopedId, success: true });
	});

	try {
		await uninstallApp(target, scopedId);
		await uninstallApp(target, scopedId, { deleteStorage: true });
	} finally {
		globalThis.fetch = originalFetch;
	}

	expect(bodies).toEqual([null, JSON.stringify({ delete_storage: true })]);
});
