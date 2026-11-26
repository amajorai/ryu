// The paths, methods and body shapes are a contract with Core's
// `agent_account_pools/routes.rs`. A rename on either side would leave the
// settings page writing values Core refuses (its bodies deny unknown fields).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AccountPoolMember } from "./account-pools.ts";
import type { ApiTarget } from "./client.ts";

// The client module graph loads react-dom. Register the DOM before it loads,
// so a component test that runs after this file in the same process still
// gets a react-dom that handles input events.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const {
	accountPoolsUnsupported,
	agentAccountMode,
	createAccountPool,
	deleteAccountPool,
	fetchAccountPools,
	memberKey,
	moveBackup,
	setAgentAccountMode,
	setAgentAccountPool,
	supportsAutoMode,
	toggleMember,
	updateAccountPool,
} = await import("./account-pools.ts");

const target: ApiTarget = {
	url: "https://account-pools.fixture",
	token: "account-pools-token",
	userJwt: "account-pools-user",
};
const BASE = "/api/pi-config/providers/account-pools";
const MEMBER: AccountPoolMember = {
	accountId: "work",
	providerId: "claude-pro-max",
};
const POOL = { accounts: [MEMBER], id: "pool-1", name: "Mythos" };

interface Call {
	body: unknown;
	method: string;
	path: string;
}

const originalFetch = globalThis.fetch;
let calls: Call[];
let respond: (call: Call) => Response;

beforeEach(() => {
	calls = [];
	respond = () => Response.json(POOL);
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const call: Call = {
				body: init?.body ? JSON.parse(String(init.body)) : null,
				method: init?.method ?? "GET",
				path: new URL(String(input)).pathname,
			};
			calls.push(call);
			return Promise.resolve(respond(call));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("account pools client", () => {
	it("reads the pools, the pool of each agent and the limits", async () => {
		const catalog = {
			agents: { security: "pool-1" },
			maxPoolAccounts: 200,
			maxPools: 50,
			pools: [POOL],
		};
		respond = () => Response.json(catalog);
		expect(await fetchAccountPools(target)).toEqual(catalog);
		expect(calls).toEqual([{ body: null, method: "GET", path: BASE }]);
	});

	it("creates a pool from a name and account ids only", async () => {
		const created = await createAccountPool(target, {
			accounts: [MEMBER],
			name: "Mythos",
		});
		expect(created).toEqual(POOL);
		expect(calls).toEqual([
			{
				body: { accounts: [MEMBER], name: "Mythos" },
				method: "POST",
				path: BASE,
			},
		]);
	});

	it("sends only the part of a pool that changes", async () => {
		await updateAccountPool(target, "pool 1", { name: "Security" });
		await updateAccountPool(target, "pool 1", { accounts: [] });
		expect(calls).toEqual([
			{
				body: { name: "Security" },
				method: "PUT",
				path: `${BASE}/pool%201`,
			},
			{ body: { accounts: [] }, method: "PUT", path: `${BASE}/pool%201` },
		]);
	});

	it("deletes a pool and accepts the empty answer", async () => {
		respond = () => new Response(null, { status: 204 });
		await deleteAccountPool(target, "pool-1");
		expect(calls).toEqual([
			{ body: null, method: "DELETE", path: `${BASE}/pool-1` },
		]);
	});

	it("gives an agent a pool and clears it with null", async () => {
		respond = (call) =>
			Response.json({ agentId: "security", ...(call.body as object) });
		expect(await setAgentAccountPool(target, "security", "pool-1")).toEqual({
			agentId: "security",
			poolId: "pool-1",
		});
		expect(await setAgentAccountPool(target, "security", null)).toEqual({
			agentId: "security",
			poolId: null,
		});
		expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
			["PUT", `${BASE}/agents/security`, { poolId: "pool-1" }],
			["PUT", `${BASE}/agents/security`, { poolId: null }],
		]);
	});

	it("tells a node without account pools from a failed read", async () => {
		const failure = async (status: number) => {
			respond = () => Response.json({ error: "no" }, { status });
			return await fetchAccountPools(target).catch((error) => error);
		};
		expect(accountPoolsUnsupported(await failure(404))).toBe(true);
		expect(accountPoolsUnsupported(await failure(500))).toBe(false);
		expect(accountPoolsUnsupported(new Error("offline"))).toBe(false);
	});

	it("surfaces Core's refusal", async () => {
		respond = () =>
			Response.json({ error: "account pool not found" }, { status: 404 });
		await expect(
			updateAccountPool(target, "missing", { name: "X" })
		).rejects.toMatchObject({ status: 404 });
	});
});

describe("pool members", () => {
	it("keys a member by provider and account, so equal ids of two providers differ", () => {
		expect(memberKey(MEMBER)).not.toBe(
			memberKey({ accountId: "work", providerId: "chatgpt" })
		);
	});

	it("adds an absent member and removes a present one", () => {
		const other = { accountId: "home", providerId: "claude-pro-max" };
		expect(toggleMember([], MEMBER)).toEqual([MEMBER]);
		expect(toggleMember([MEMBER, other], MEMBER)).toEqual([other]);
		expect(toggleMember([other], MEMBER)).toEqual([other, MEMBER]);
	});
});

describe("Auto and backup models", () => {
	const OPUS = { model: "claude-opus-4-7", providerId: "claude-pro-max" };
	const GPT = { model: "gpt-5.5", providerId: "chatgpt" };
	const SONNET = { model: "claude-sonnet-4-6", providerId: "claude-pro-max" };

	it("reads Auto, the backups and their limit from a Core that has them", async () => {
		const catalog = {
			agents: { security: "pool-1" },
			auto: ["writer"],
			backups: { writer: [OPUS, GPT] },
			maxBackups: 8,
			maxPoolAccounts: 200,
			maxPools: 50,
			pools: [POOL],
		};
		respond = () => Response.json(catalog);
		const read = await fetchAccountPools(target);
		expect(read).toEqual(catalog);
		expect(supportsAutoMode(read)).toBe(true);
		expect(agentAccountMode(read, "writer")).toBe("auto");
		expect(agentAccountMode(read, "security")).toBe("pool");
		expect(agentAccountMode(read, "other")).toBe("none");
	});

	it("knows a Core without Auto by the missing limit", () => {
		expect(
			supportsAutoMode({
				agents: {},
				maxPoolAccounts: 200,
				maxPools: 50,
				pools: [],
			})
		).toBe(false);
	});

	it("sends the mode, the pool only for a pool, and backups only when given", async () => {
		respond = (call) =>
			Response.json({
				agentId: "security",
				backups: [],
				mode: "none",
				poolId: null,
				...(call.body as object),
			});
		await setAgentAccountMode(target, "security", {
			mode: "auto",
			poolId: "ignored",
		});
		await setAgentAccountMode(target, "security", {
			mode: "pool",
			poolId: "pool-1",
		});
		const saved = await setAgentAccountMode(target, "security", {
			backups: [OPUS, GPT],
			mode: "none",
			poolId: null,
		});
		expect(saved.backups).toEqual([OPUS, GPT]);
		expect(calls.map((call) => call.body)).toEqual([
			{ mode: "auto" },
			{ mode: "pool", poolId: "pool-1" },
			{ backups: [OPUS, GPT], mode: "none" },
		]);
		expect(calls.every((call) => call.method === "PUT")).toBe(true);
		expect(calls[0]?.path).toBe(`${BASE}/agents/security`);
	});

	it("moves a backup one place and leaves the ends alone", () => {
		const list = [OPUS, SONNET, GPT];
		expect(moveBackup(list, 2, -1)).toEqual([OPUS, GPT, SONNET]);
		expect(moveBackup(list, 0, 1)).toEqual([SONNET, OPUS, GPT]);
		expect(moveBackup(list, 0, -1)).toBe(list);
		expect(moveBackup(list, 2, 1)).toBe(list);
		expect(list).toEqual([OPUS, SONNET, GPT]);
	});
});
