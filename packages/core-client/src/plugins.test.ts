// packages/core-client/src/plugins.test.ts
//
// Tests for the CLI-command path-safety guard. `isSafeCommandPath` is the shared
// predicate BOTH the manifest→AppInfo mapper (`toAppCommands`, which drops unsafe
// commands so the dispatcher can never see them) AND the TUI's `execAppCommand`
// (which refuses to build a request URL from one) rely on. It mirrors Core's
// `validate_cli_command_path` (`crates/ryu-kernel-contracts`). A command path is
// concatenated onto `/api/ext/<appId>` and fetched, and the URL parser normalizes
// `..` (incl. `%2e` / backslash forms) BEFORE the request is sent — a traversal
// path would escape the plugin's proxy scope and hit an arbitrary internal route
// with the full node bearer. These vectors keep that closed.

import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	disableApp,
	enableApp,
	installApp,
	installPluginFromCatalog,
	isSafeCommandPath,
	previewAppLifecycle,
	uninstallApp,
	updateApp,
} from "./plugins.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test("isSafeCommandPath accepts plain absolute sub-paths", () => {
	for (const ok of ["/status", "/inboxes/send", "/a-b_c/1", "/x?y=1", "/"]) {
		expect(isSafeCommandPath(ok)).toBe(true);
	}
});

test("isSafeCommandPath rejects path-traversal and escape forms", () => {
	for (const bad of [
		"/../../../v1/chat/completions",
		"/../api/plugins/@ryu/mail/uninstall",
		"/foo/../../bar",
		"/%2e%2e/%2e%2e/v1",
		"/foo/%2E%2E/bar",
		"/..\\..\\v1",
		"/foo%2fbar",
		"/foo%5cbar",
		"status", // not absolute
		"", // empty
	]) {
		expect(isSafeCommandPath(bad)).toBe(false);
	}
});

test("lifecycle routes encode a scoped plugin id exactly once", async () => {
	const urls: string[] = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/uninstall")) {
				return Promise.resolve(
					Response.json({
						disabled: ["@ryu/mail"],
						removed: "@ryu/mail",
						success: true,
					})
				);
			}
			return Promise.resolve(
				Response.json({
					app: {
						approved_grants: [],
						created_at: null,
						enabled: true,
						id: "@ryu/mail",
						updated_at: null,
						version: "1.0.0",
					},
				})
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	const target: ApiTarget = {
		token: "node-token",
		url: "http://127.0.0.1:7980",
		userJwt: null,
	};
	const scopedId = "@ryu/mail";

	await installApp(target, scopedId);
	await enableApp(target, scopedId);
	await disableApp(target, scopedId, { cascade: true });
	await uninstallApp(target, scopedId, { cascade: true });
	await updateApp(target, scopedId, { force: true });

	expect(urls).toEqual([
		"http://127.0.0.1:7980/api/plugins/%40ryu%2Fmail/install",
		"http://127.0.0.1:7980/api/plugins/%40ryu%2Fmail/enable",
		"http://127.0.0.1:7980/api/plugins/%40ryu%2Fmail/disable?cascade=true",
		"http://127.0.0.1:7980/api/plugins/%40ryu%2Fmail/uninstall?cascade=true",
		"http://127.0.0.1:7980/api/plugins/%40ryu%2Fmail/update",
	]);
	for (const url of urls) {
		expect(url).not.toContain("%2540ryu%252Fmail");
	}
});

test("catalog install forwards the plugin id without a purchase gate", async () => {
	interface CapturedPluginInstall {
		current: { body: string; url: string } | null;
	}
	const request: CapturedPluginInstall = {
		current: null,
	};
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			request.current = { body: String(init?.body), url: String(input) };
			return Promise.resolve(Response.json({ success: true }));
		},
		{ preconnect: realFetch.preconnect }
	);

	await installPluginFromCatalog(
		{
			token: "node-token",
			url: "http://127.0.0.1:7980",
			userJwt: null,
		},
		"@ryu/paid-plugin"
	);

	const captured = request.current;
	if (!captured) {
		throw new Error("catalog install did not make a request");
	}
	expect(captured.body).toBe(JSON.stringify({ id: "@ryu/paid-plugin" }));
	expect(captured.url).toBe(
		"http://127.0.0.1:7980/api/plugins/catalog/install"
	);
});

test("lifecycle previews use the dry-run body/query without mutating verbs", async () => {
	const requests: Array<{ body: string | undefined; url: string }> = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ body: init?.body?.toString(), url: String(input) });
			return Promise.resolve(
				Response.json({
					action: "install",
					dryRun: true,
					success: true,
				})
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	const target: ApiTarget = {
		token: "node-token",
		url: "http://127.0.0.1:7980",
		userJwt: null,
	};

	await previewAppLifecycle(target, "@ryu/mail", "install");
	await previewAppLifecycle(target, "@ryu/mail", "disable", {
		cascade: true,
		force: true,
	});

	expect(requests).toEqual([
		{
			body: JSON.stringify({ dryRun: true }),
			url: "http://127.0.0.1:7980/api/plugins/%40ryu%2Fmail/install",
		},
		{
			body: undefined,
			url: "http://127.0.0.1:7980/api/plugins/%40ryu%2Fmail/disable?dryRun=true&cascade=true&force=true",
		},
	]);
});
