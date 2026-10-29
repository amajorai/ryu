// `ryu-cli secrets seal` must seal the vault through Core's seal route and
// never reach the unseal route. Core is faked through the target's injected
// `fetch`, so nothing touches a real node.

import { expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

interface SealCall {
	body: string | undefined;
	method: string;
	path: string;
}

function makeIo() {
	let outBuf = "";
	return {
		io: {
			out: (s) => {
				outBuf += s;
			},
			err: () => undefined,
		} satisfies CliIO,
		out: () => outBuf,
	};
}

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

const sealedAuto = {
	mode: "auto",
	sealed: true,
	shares: 0,
	threshold: 0,
	progress: 0,
	keyVersions: [1, 2],
	activeKeyVersion: 2,
};
const unsealedAuto = { ...sealedAuto, sealed: false };

/** Seal answers sealed; unseal (which must never be hit) answers unsealed. */
function sealNode() {
	const calls: SealCall[] = [];
	const target: ApiTarget = {
		url: "http://node.test",
		token: "node-token",
		fetch: (input, init) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			calls.push({
				body: init?.body === undefined ? undefined : String(init.body),
				method,
				path: url.pathname,
			});
			if (method === "POST" && url.pathname === "/api/vault/sys/seal") {
				return Promise.resolve(Response.json({ seal: sealedAuto }));
			}
			if (method === "POST" && url.pathname === "/api/vault/sys/unseal") {
				return Promise.resolve(Response.json({ seal: unsealedAuto }));
			}
			return Promise.resolve(
				Response.json({ error: "no route" }, { status: 404 })
			);
		},
	};
	return { calls, target };
}

test("secrets seal POSTs the seal route once and prints the sealed line", async () => {
	const node = sealNode();
	const cap = makeIo();
	const code = await runCli(["secrets", "seal"], {
		api: stubApi(),
		io: cap.io,
		target: node.target,
	});
	expect(code).toBe(0);
	expect(node.calls).toEqual([
		{ body: "{}", method: "POST", path: "/api/vault/sys/seal" },
	]);
	expect(cap.out()).toBe("Sealed (auto).\n");
});

test("secrets seal --json prints the seal state and never calls unseal", async () => {
	const node = sealNode();
	const cap = makeIo();
	const code = await runCli(["secrets", "seal", "--json"], {
		api: stubApi(),
		io: cap.io,
		target: node.target,
	});
	expect(code).toBe(0);
	expect(node.calls.map((call) => call.path)).toEqual(["/api/vault/sys/seal"]);
	expect(JSON.parse(cap.out())).toEqual(sealedAuto);
});
