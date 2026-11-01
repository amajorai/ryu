import { expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
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
import {
	describeDependencyError,
	parseLifecycleError,
} from "./plugins-lifecycle-errors.ts";

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
		{ version: "v0.8.0" },
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

const english: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

test("version requirements render a floor only for bare versions", () => {
	const mismatch = (required: string) =>
		describeDependencyError(
			{
				code: "version_mismatch",
				dependency: "@ryu/spaces",
				installed: "2.0.0",
				plugin: "@ryu/meetings",
				required,
			},
			english
		);
	expect(mismatch("2.1.0")).toBe(
		"@ryu/meetings needs @ryu/spaces 2.1.0 or newer, but 2.0.0 is installed. Update it first."
	);
	expect(mismatch(">=1.2, <2")).toBe(
		"@ryu/meetings needs @ryu/spaces >=1.2, <2, but 2.0.0 is installed."
	);
	expect(
		describeDependencyError(
			{
				code: "missing_dependency",
				dependency: "@ryu/spaces",
				plugin: "@ryu/meetings",
				required: "^1.2",
			},
			english
		)
	).toBe("@ryu/meetings needs @ryu/spaces (^1.2). Install it first.");
});

test("dependent_version_mismatch does not offer a force the desktop cannot send", () => {
	expect(
		describeDependencyError(
			{
				code: "dependent_version_mismatch",
				dependency: "@ryu/spaces",
				incoming: "1.0.0",
				plugin: "@ryu/meetings",
				required: "1.2.0",
			},
			english
		)
	).toBe(
		"Updating @ryu/spaces to 1.0.0 would break @ryu/meetings, which needs 1.2.0. Update @ryu/meetings first."
	);
});

test("only a 403 carrying denied_grants is a Gateway grant denial", async () => {
	const mandatory = await parseLifecycleError(
		Response.json(
			{
				code: "mandatory",
				error: "app 'core' is required for Ryu to run and cannot be disabled",
				hint: "this app is part of Core; force does not override it",
			},
			{ status: 403 }
		),
		"/api/plugins/core/disable"
	);
	expect(mandatory.grantsDenied).toBe(false);
	expect(mandatory.message).toBe(
		"app 'core' is required for Ryu to run and cannot be disabled"
	);

	const acl = await parseLifecycleError(
		Response.json(
			{
				error: "app_lifecycle_permission_denied",
				required_permission: "apps:manage",
			},
			{ status: 403 }
		),
		"/api/plugins/core/disable"
	);
	expect(acl.grantsDenied).toBe(false);
	expect(acl.message).toBe(
		"You don't have permission (apps:manage) to change apps on this node."
	);

	const gateway = await parseLifecycleError(
		Response.json({ denied_grants: ["fs:write"] }, { status: 403 }),
		"/api/plugins/core/enable"
	);
	expect(gateway.grantsDenied).toBe(true);
	expect(gateway.message).toBe("Gateway denied grants: fs:write");
});
