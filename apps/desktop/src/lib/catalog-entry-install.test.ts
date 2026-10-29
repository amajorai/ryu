import { afterAll, beforeEach, expect, test } from "bun:test";
import type { CatalogEntry } from "@/src/lib/api/plugins.ts";
import { installCatalogEntry } from "./catalog-entry-install.ts";

// A real Core stand-in records which install route each catalog listing hits,
// so the routing (and every refusal that must make NO request) is proven on
// the wire rather than against mocked API helpers.
interface RecordedCall {
	body: unknown;
	method: string;
	path: string;
}

const calls: RecordedCall[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		const text = await request.text();
		calls.push({
			body: text ? JSON.parse(text) : null,
			method: request.method,
			path,
		});
		if (path === "/api/marketplace/packages/install") {
			return Response.json({
				package: {
					enabled: true,
					id: "skill-pack",
					installed_at_unix_ms: 1,
					kind: "skill",
					package_digest: "sha256:fixture",
					version: "1.0.0",
				},
			});
		}
		if (path.endsWith("/install") && path.startsWith("/api/plugins/")) {
			return Response.json({
				app: {
					approved_grants: [],
					created_at: null,
					enabled: true,
					id: "@ryu/mail",
					updated_at: null,
					version: "1.0.0",
				},
			});
		}
		return Response.json({ ok: true });
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	calls.length = 0;
});

const target = { url: server.url.toString(), token: "fixture-node" };

function entry(
	overrides: Partial<CatalogEntry> & { id: string }
): CatalogEntry {
	return {
		description: "",
		kinds: ["plugin"],
		name: overrides.id,
		tags: [],
		version: "1.0.0",
		...overrides,
	} as CatalogEntry;
}

function recordingPolicy(result: string | null) {
	const seen: boolean[] = [];
	return {
		orgInstallBlock: (fromCatalog: boolean) => {
			seen.push(fromCatalog);
			return result;
		},
		seen,
	};
}

test("a descriptor-only listing is refused as browse-only and makes no request", async () => {
	const policy = recordingPolicy(null);
	await expect(
		installCatalogEntry(
			target,
			entry({ descriptor_only: true, id: "linear-descriptor" }),
			{ installed: false, orgInstallBlock: policy.orgInstallBlock }
		)
	).rejects.toThrow(
		"Integration descriptors are browse-only — open the link to configure."
	);
	expect(calls).toEqual([]);
	expect(policy.seen).toEqual([]);
});

test("a community listing is refused before any request or policy check", async () => {
	const policy = recordingPolicy(null);
	await expect(
		installCatalogEntry(
			target,
			entry({ id: "gh:someone/x", origin: "community" }),
			{ installed: false, orgInstallBlock: policy.orgInstallBlock }
		)
	).rejects.toThrow("Community listings are browse-only");
	expect(calls).toEqual([]);
	expect(policy.seen).toEqual([]);
});

test("an organization policy block throws its message and makes no request", async () => {
	const policy = recordingPolicy("Your organization blocks catalog installs.");
	await expect(
		installCatalogEntry(target, entry({ id: "acme-plugin" }), {
			channel: "beta",
			installed: false,
			orgInstallBlock: policy.orgInstallBlock,
		})
	).rejects.toThrow("Your organization blocks catalog installs.");
	expect(calls).toEqual([]);
	expect(policy.seen).toEqual([true]);
});

test("the org check is asked fromCatalog=false for a built-in or an installed entry", async () => {
	const builtIn = recordingPolicy(null);
	await installCatalogEntry(
		target,
		entry({ id: "@ryu/mail", source: "built-in" }),
		{ installed: false, orgInstallBlock: builtIn.orgInstallBlock }
	);
	const installed = recordingPolicy(null);
	await installCatalogEntry(target, entry({ id: "acme-plugin" }), {
		installed: true,
		orgInstallBlock: installed.orgInstallBlock,
	});
	expect(builtIn.seen).toEqual([false]);
	expect(installed.seen).toEqual([false]);
});

test("a not-installed portable package installs as a package and skips the org policy", async () => {
	const policy = recordingPolicy("blocked");
	await installCatalogEntry(
		target,
		entry({
			github_source: { owner: "acme", repo: "skill-pack" },
			id: "skill-pack",
			package_kind: " skill ",
		}),
		{ installed: false, orgInstallBlock: policy.orgInstallBlock }
	);
	expect(policy.seen).toEqual([]);
	expect(calls).toEqual([
		{
			body: { id: "skill-pack", kind: "skill" },
			method: "POST",
			path: "/api/marketplace/packages/install",
		},
	]);
});

test("a non-built-in listing installs through the signed catalog sink with its channel", async () => {
	await installCatalogEntry(target, entry({ id: "acme-plugin" }), {
		channel: "beta",
		installed: false,
		orgInstallBlock: () => null,
	});
	expect(calls).toEqual([
		{
			body: { channel: "beta", id: "acme-plugin" },
			method: "POST",
			path: "/api/plugins/catalog/install",
		},
	]);
});

test("a built-in installs through installApp and never forwards the channel", async () => {
	await installCatalogEntry(
		target,
		entry({ id: "@ryu/mail", source: "built-in" }),
		{ channel: "beta", installed: false, orgInstallBlock: () => null }
	);
	expect(calls).toEqual([
		{ body: null, method: "POST", path: "/api/plugins/%40ryu%2Fmail/install" },
	]);
});
