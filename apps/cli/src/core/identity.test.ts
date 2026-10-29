import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	disposeCliIdentity,
	getCliIdentitySnapshot,
	identityBrokerFor,
	installCliIdentity,
	refreshCliIdentityAfterAccountChange,
} from "./identity.ts";
import { DEFAULT_CORE_URL } from "./target.ts";

const realFetch = globalThis.fetch;

// Every case names its own data directory, so none reads this machine's real
// `secrets/node-auth.token`.
const emptyDataDir = mkdtempSync(join(tmpdir(), "ryu-broker-empty-"));
const mintedDataDir = mkdtempSync(join(tmpdir(), "ryu-broker-minted-"));
mkdirSync(join(mintedDataDir, "secrets"), { recursive: true });
writeFileSync(join(mintedDataDir, "secrets", "node-auth.token"), "minted\n");

afterAll(() => {
	rmSync(emptyDataDir, { force: true, recursive: true });
	rmSync(mintedDataDir, { force: true, recursive: true });
});

afterEach(() => {
	disposeCliIdentity();
	globalThis.fetch = realFetch;
});

describe("identityBrokerFor", () => {
	test("a local target brokers its own identity", () => {
		expect(
			identityBrokerFor({ token: "t", url: "http://127.0.0.1:7980" }, {})
		).toEqual({ token: "t", url: "http://127.0.0.1:7980" });
	});

	test("a remote target asks the local Core, never the remote node", () => {
		expect(
			identityBrokerFor(
				{ token: "remote", url: "https://team.example.ts.net" },
				{ RYU_IDENTITY_CORE_TOKEN: "local" }
			)
		).toEqual({ token: "local", url: DEFAULT_CORE_URL });
	});

	test("an explicit broker URL wins", () => {
		expect(
			identityBrokerFor(
				{ token: "t", url: "https://team.example.ts.net" },
				{
					RYU_DIR: emptyDataDir,
					RYU_IDENTITY_CORE_URL: "http://127.0.0.1:9000",
				}
			)
		).toEqual({ token: null, url: "http://127.0.0.1:9000" });
	});

	test("a remote target without RYU_IDENTITY_CORE_TOKEN presents the token the local Core minted", () => {
		expect(
			identityBrokerFor(
				{ token: "remote", url: "https://team.example.ts.net" },
				{ RYU_CORE_TOKEN: "remote", RYU_DIR: mintedDataDir }
			)
		).toEqual({ token: "minted", url: DEFAULT_CORE_URL });
	});

	test("an operator-provisioned RYU_TOKEN comes before the minted token", () => {
		expect(
			identityBrokerFor(
				{ token: "remote", url: "https://team.example.ts.net" },
				{ RYU_DIR: mintedDataDir, RYU_TOKEN: "provisioned" }
			)
		).toEqual({ token: "provisioned", url: DEFAULT_CORE_URL });
	});

	test("this machine's tokens never go to a broker on another machine", () => {
		expect(
			identityBrokerFor(
				{ token: "remote", url: "https://team.example.ts.net" },
				{
					RYU_DIR: mintedDataDir,
					RYU_IDENTITY_CORE_URL: "https://broker.example.com",
					RYU_TOKEN: "provisioned",
				}
			)
		).toEqual({ token: null, url: "https://broker.example.com" });
	});

	test("with nothing minted a remote target's broker has no bearer", () => {
		expect(
			identityBrokerFor(
				{ token: "remote", url: "https://team.example.ts.net" },
				{ RYU_DIR: emptyDataDir }
			)
		).toEqual({ token: null, url: DEFAULT_CORE_URL });
	});
});

describe("identity snapshot", () => {
	test("counts each announced account change once, however many publishes it takes", async () => {
		// No account can mint a user JWT here; the exchange answers 404.
		globalThis.fetch = Object.assign(
			() => Promise.resolve(new Response(null, { status: 404 })),
			{ preconnect: realFetch.preconnect }
		);
		const start = getCliIdentitySnapshot();
		await installCliIdentity({ token: null, url: "http://127.0.0.1:7980" });
		const installed = getCliIdentitySnapshot();
		expect(installed.accountGeneration).toBe(start.accountGeneration + 1);
		expect(installed.refreshing).toBe(false);

		await refreshCliIdentityAfterAccountChange();
		const switched = getCliIdentitySnapshot();
		// Refreshing, then settled: two publishes, one account change.
		expect(switched.version).toBe(installed.version + 2);
		expect(switched.accountGeneration).toBe(installed.accountGeneration + 1);

		disposeCliIdentity();
		expect(getCliIdentitySnapshot().accountGeneration).toBe(
			switched.accountGeneration + 1
		);
	});
});
