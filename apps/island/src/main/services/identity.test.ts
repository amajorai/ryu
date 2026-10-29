import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityBrokerFor } from "./identity.ts";

const LOCAL = "http://127.0.0.1:7777";
const REMOTE = "https://team-node.example.com";

const savedEnv = {
	RYU_CORE_TOKEN: process.env.RYU_CORE_TOKEN,
	RYU_DIR: process.env.RYU_DIR,
	RYU_TOKEN: process.env.RYU_TOKEN,
};
const realFetch = globalThis.fetch;
const dataDir = mkdtempSync(join(tmpdir(), "island-identity-"));

interface BrokerCall {
	authorization: string | null;
	url: string;
}
const calls: BrokerCall[] = [];
let mintedToken = "jwt-one";

function restoreEnv(name: keyof typeof savedEnv): void {
	const value = savedEnv[name];
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

beforeAll(() => {
	delete process.env.RYU_CORE_TOKEN;
	process.env.RYU_TOKEN = "fleet-node-token";
	process.env.RYU_DIR = dataDir;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({
			authorization: headers.get("Authorization"),
			url: String(input),
		});
		return Response.json({
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
			token: mintedToken,
		});
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
	restoreEnv("RYU_CORE_TOKEN");
	restoreEnv("RYU_TOKEN");
	restoreEnv("RYU_DIR");
	rmSync(dataDir, { force: true, recursive: true });
});

/** A fresh module instance, so the cached source never leaks between tests or
 * `--rerun-each` iterations. */
function loadIdentity(): Promise<typeof import("./identity.ts")> {
	return import(`./identity.ts?fresh=${randomUUID()}`);
}

beforeEach(() => {
	calls.length = 0;
	mintedToken = "jwt-one";
});

async function flush(): Promise<void> {
	for (let tick = 0; tick < 10; tick += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("identityBrokerFor", () => {
	it("brokers through the configured Core when it is local", () => {
		expect(
			identityBrokerFor({
				coreBaseUrl: LOCAL,
				coreToken: "local-bearer",
				defaultCoreBaseUrl: "http://127.0.0.1:9999",
			})
		).toEqual({ token: "local-bearer", url: LOCAL });
	});

	it("never hands a remote node's bearer to the broker", () => {
		const broker = identityBrokerFor({
			coreBaseUrl: REMOTE,
			coreToken: "remote-node-secret",
			defaultCoreBaseUrl: LOCAL,
		});
		expect(broker).toEqual({ token: "fleet-node-token", url: LOCAL });
		expect(broker.token).not.toBe("remote-node-secret");
	});

	it("treats a userinfo-spoofed localhost URL as remote", () => {
		expect(
			identityBrokerFor({
				coreBaseUrl: "http://localhost:80@evil.example.com/",
				coreToken: "remote-node-secret",
				defaultCoreBaseUrl: LOCAL,
			}).url
		).toBe(LOCAL);
	});
});

describe("startIslandIdentity", () => {
	it("is null before start, then serves the JWT minted by the broker", async () => {
		const { currentIslandUserJwt, startIslandIdentity } = await loadIdentity();
		expect(currentIslandUserJwt()).toBeNull();
		startIslandIdentity({ token: "local-bearer", url: LOCAL });
		await flush();
		expect(calls).toEqual([
			{
				authorization: "Bearer local-bearer",
				url: `${LOCAL}/api/auth/user-jwt`,
			},
		]);
		expect(currentIslandUserJwt()).toBe("jwt-one");
	});

	it("restarting with a new broker exchanges against that Core", async () => {
		const { currentIslandUserJwt, startIslandIdentity } = await loadIdentity();
		startIslandIdentity({ token: "local-bearer", url: LOCAL });
		await flush();
		expect(currentIslandUserJwt()).toBe("jwt-one");
		mintedToken = "jwt-two";
		startIslandIdentity({
			token: "other-bearer",
			url: "http://localhost:8888",
		});
		await flush();
		expect(calls).toHaveLength(2);
		expect(calls.at(-1)).toEqual({
			authorization: "Bearer other-bearer",
			url: "http://localhost:8888/api/auth/user-jwt",
		});
		expect(currentIslandUserJwt()).toBe("jwt-two");
	});
});
