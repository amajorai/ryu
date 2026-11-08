// `ryu-cli secrets broker …` from an agent that holds only its broker
// session, against a local plain-HTTP Core with no node token: the case of an
// agent Ryu started through the broker (Core injects the proxy variables,
// never RYU_CORE_TOKEN). The session reaches Core only after Core proves it
// holds that session, on the same connection.

import { afterEach, expect, test } from "bun:test";
import {
	type FakeCoreRequest,
	useFakeLoopbackCore,
} from "@ryuhq/core-client/__tests__/fake-loopback-core";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CoreApi } from "../cli/types.ts";

let restore: (() => void) | null = null;

afterEach(() => {
	restore?.();
	restore = null;
});

function stubApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
	};
}

/** A tokenless local target whose own fetch must never be used. */
const TOKENLESS: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: null,
	fetch: () => Promise.reject(new Error("the target's fetch was used")),
};

async function run(argv: string[], env: Record<string, string>) {
	let out = "";
	let err = "";
	const code = await runCli(argv, {
		api: stubApi(),
		env: { HOME: "/home/me", CLAUDECODE: "1", ...env },
		io: {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		},
		promptLine: () => Promise.resolve(null),
		spawn: () => Promise.resolve(0),
		target: TOKENLESS,
	});
	return { code, err, out };
}

for (const [label, env] of [
	["proxy variables", { HTTPS_PROXY: "http://rvb:rvb_x@127.0.0.1:9000" }],
	["RYU_VAULT_BROKER_SESSION", { RYU_VAULT_BROKER_SESSION: "rvb_x" }],
] as const) {
	test(`discover reaches a tokenless local Core with the session from ${label}`, async () => {
		const seen: FakeCoreRequest[] = [];
		restore = useFakeLoopbackCore({ sessions: ["rvb_x"], seen });
		const { code, err, out } = await run(
			["secrets", "broker", "discover"],
			env
		);
		expect(err).toBe("");
		expect(code).toBe(0);
		expect(out).toContain("Environment dev");
		const discover = seen.find(
			(entry) => entry.path === "/api/vault/agent/broker/discover"
		);
		expect(discover?.authorization).toBe("Bearer rvb_x");
		const challenge = seen.find(
			(entry) => entry.connection === discover?.connection
		);
		expect(challenge?.path).toBe("/api/health/identity");
		expect(challenge?.authorization).toBeNull();
	});
}

test("propose and proposal work with only the session", async () => {
	const seen: FakeCoreRequest[] = [];
	restore = useFakeLoopbackCore({ sessions: ["rvb_x"], seen });
	const env = { RYU_VAULT_BROKER_SESSION: "rvb_x" };
	const proposed = await run(
		[
			"secrets",
			"broker",
			"propose",
			"--message",
			"need linear",
			"--host",
			"api.linear.app",
		],
		env
	);
	expect(proposed.code).toBe(0);
	expect(proposed.out).toContain("Proposal bp_1 is pending");
	const checked = await run(["secrets", "broker", "proposal", "bp_1"], env);
	expect(checked.code).toBe(3);
	const sent = seen.filter((entry) => entry.path !== "/api/health/identity");
	expect(sent.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
		"POST /api/vault/agent/broker/proposals",
		"GET /api/vault/agent/broker/proposals/bp_1",
	]);
	expect(sent.every((entry) => entry.authorization === "Bearer rvb_x")).toBe(
		true
	);
});

test("a listener that cannot prove the session gets nothing", async () => {
	const seen: FakeCoreRequest[] = [];
	restore = useFakeLoopbackCore({ sessions: ["rvb_someone_else"], seen });
	const { code, err } = await run(["secrets", "broker", "discover"], {
		RYU_VAULT_BROKER_SESSION: "rvb_x",
	});
	expect(code).not.toBe(0);
	expect(err).toContain("could not prove it is your Ryu Core");
	expect(seen.some((entry) => entry.authorization !== null)).toBe(false);
});
