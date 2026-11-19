import { afterEach, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	fetchInstalledPortablePackages,
	setPortablePackageEnabled,
} from "./marketplace-portable-packages.ts";

const TARGET = { token: "node-token", url: "http://core.test" };
const originalFetch = globalThis.fetch;
const installed = {
	enabled: false,
	id: "@ryu/pack",
	installed_at_unix_ms: 1,
	kind: "skill",
	package_digest: "sha256:abc",
	version: "1.0.0",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function serve(body: object): { method: string; url: string }[] {
	const calls: { method: string; url: string }[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, (input, init) => {
		calls.push({ method: init?.method ?? "GET", url: String(input) });
		return Promise.resolve(Response.json(body));
	});
	return calls;
}

test("disables a package through its encoded Core route", async () => {
	const calls = serve({ package: installed });
	const result = await setPortablePackageEnabled(
		TARGET,
		{ id: "@ryu/pack", kind: "skill" },
		false
	);
	expect(result).toEqual(installed);
	expect(calls).toEqual([
		{
			method: "POST",
			url: "http://core.test/api/marketplace/packages/skill/%40ryu%2Fpack/disable",
		},
	]);
});

test("treats a missing installed list as no packages", async () => {
	serve({});
	expect(await fetchInstalledPortablePackages(TARGET)).toEqual([]);
});
