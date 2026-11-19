// `ryu secrets …` dispatch tests: step-up refusals and `secrets confirm`. Core is faked through the
// target's injected `fetch`, child processes through `spawn`, and stdin
// through `readStdin`, so nothing touches a node, spawns, or reads the real
// terminal. Shared fixtures are in `secrets-dispatch-fixture.ts`.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import { DEFAULT_CORE_URL } from "../core/target.ts";

import { fakeNode, makeIo, stubApi, T } from "./secrets-dispatch-fixture.ts";

const stepUpRefusal = (): Response =>
	Response.json(
		{
			action: "change or reveal access keys and shared secrets",
			enrolmentRequired: false,
			error: "STEP_UP_REQUIRED",
			message: "Verify your identity to continue",
			methods: ["totp", "otp"],
			scope: "org.credentials",
		},
		{ status: 403 }
	);

test("secrets get, export and run refuse with how to confirm when shared values need a step-up", async () => {
	for (const argv of [
		["secrets", "get", "API_KEY"],
		["secrets", "export"],
		["secrets", "run", "--", "node", "app.js"],
	]) {
		const cap = makeIo();
		const node = fakeNode({
			"POST /api/vault/export": stepUpRefusal,
			"POST /api/vault/secrets/API_KEY/reveal": stepUpRefusal,
		});
		let spawned = false;
		const code = await runCli(argv, {
			api: stubApi(),
			env: {},
			io: cap.io,
			spawn: () => {
				spawned = true;
				return Promise.resolve(0);
			},
			target: node.target,
		});
		expect(code).toBe(1);
		// No partial export: the child never starts without the shared values.
		expect(spawned).toBe(false);
		expect(cap.out()).toBe("");
		expect(cap.err()).toContain("ryu secrets confirm");
	}
});

const sessionEnv = {
	RYU_AUTH_URL: "http://auth.test",
	RYU_IDENTITY_CORE_URL: "http://node.test",
};
const signedIn = {
	authenticated: true,
	pending: false,
	token: "core-session",
	userCode: null,
	verificationUri: null,
};

test("secrets confirm proves a factor on the local Core's session", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"GET /api/auth/status": signedIn,
		"GET /api/step-up/status": {
			enrolmentRequired: false,
			methods: ["otp", "totp"],
			satisfied: false,
			windowMs: 600_000,
		},
		"POST /api/step-up/verify": {
			expiresAt: T,
			scope: "org.credentials",
			verified: true,
		},
	});
	const code = await runCli(
		["secrets", "confirm", "123456", "--method", "totp"],
		{ api: stubApi(), env: sessionEnv, io: cap.io, target: node.target }
	);
	expect(code).toBe(0);
	expect(cap.err()).toContain("Confirmed for the next 10 minutes");
	const verify = node.calls.find((call) => call.path === "/api/step-up/verify");
	expect(verify?.body).toEqual({
		scope: "org.credentials",
		method: "totp",
		code: "123456",
	});
	// The step-up goes to the control plane with the local Core's session.
	expect(verify?.headers.get("authorization")).toBe("Bearer core-session");
	const status = node.calls.find((call) =>
		call.path.startsWith("/api/step-up/status")
	);
	expect(status?.path).toBe("/api/step-up/status?scope=org.credentials");
	// An authenticator code marks the session as two-factor, so the local Core
	// mints a new user JWT that carries organizations requiring it.
	const refreshed = node.calls.find((call) =>
		call.path.startsWith("/api/auth/user-jwt")
	);
	expect(refreshed?.path).toBe("/api/auth/user-jwt?fresh=true");
});

test("secrets confirm emails a code, refuses a password argument, and needs a sign-in", async () => {
	const routes = {
		"GET /api/auth/status": signedIn,
		"GET /api/step-up/status": {
			enrolmentRequired: false,
			methods: ["otp", "password"],
			satisfied: false,
		},
		"POST /api/step-up/challenge": { sent: true },
	};
	const emailed = makeIo();
	const node = fakeNode(routes);
	expect(
		await runCli(["secrets", "confirm"], {
			api: stubApi(),
			env: sessionEnv,
			io: emailed.io,
			readStdin: () => Promise.resolve(null),
			target: node.target,
		})
	).toBe(0);
	expect(emailed.err()).toContain("ryu secrets confirm CODE --method otp");
	expect(
		node.calls.find((call) => call.path === "/api/step-up/challenge")?.body
	).toEqual({ scope: "org.credentials", method: "otp" });
	expect(node.calls.some((call) => call.path === "/api/step-up/verify")).toBe(
		false
	);

	const password = makeIo();
	const passwordNode = fakeNode(routes);
	expect(
		await runCli(["secrets", "confirm", "hunter2", "--method", "password"], {
			api: stubApi(),
			env: sessionEnv,
			io: password.io,
			target: passwordNode.target,
		})
	).toBe(2);
	expect(password.err()).toContain("Pipe the password on stdin");
	expect(
		passwordNode.calls.some((call) => call.path === "/api/step-up/verify")
	).toBe(false);

	const signedOut = makeIo();
	expect(
		await runCli(["secrets", "confirm", "123456"], {
			api: stubApi(),
			env: sessionEnv,
			io: signedOut.io,
			target: fakeNode({
				"GET /api/auth/status": {
					...signedIn,
					authenticated: false,
					token: null,
				},
			}).target,
		})
	).toBe(1);
	expect(signedOut.err()).toContain("`ryu-cli login`");
});

/** Record each request's full URL and bearer, then answer from `target`. */
function recordingUrls(target: ApiTarget) {
	const seen: { authorization: string | null; url: string }[] = [];
	const inner = target.fetch;
	if (!inner) {
		throw new Error("fakeNode always provides fetch");
	}
	const recorded: ApiTarget = {
		...target,
		fetch: (input, init) => {
			seen.push({
				authorization: new Headers(init?.headers).get("authorization"),
				url: String(input),
			});
			return inner(input, init);
		},
	};
	return { recorded, seen };
}

test("secrets confirm with a remote target proves on this machine's account session", async () => {
	const cap = makeIo();
	const remote = fakeNode(
		{
			"GET /api/auth/status": signedIn,
			"GET /api/step-up/status": {
				enrolmentRequired: false,
				// The emailed code is listed first; a typed numeric code is still
				// an authenticator code.
				methods: ["otp", "totp"],
				satisfied: false,
			},
			"POST /api/step-up/verify": {
				expiresAt: T,
				scope: "org.credentials",
				verified: true,
			},
		},
		"https://remote.example"
	);
	const { recorded, seen } = recordingUrls(remote.target);
	const code = await runCli(["secrets", "confirm", "123456"], {
		api: stubApi(),
		env: { RYU_AUTH_URL: "http://auth.test", RYU_TOKEN: "local-owner" },
		io: cap.io,
		target: recorded,
	});
	expect(code).toBe(0);
	const status = seen.find((call) => call.url.endsWith("/api/auth/status"));
	// The session comes from the local Core with its own token, never from the
	// remote node and never with the remote node's token.
	expect(status?.url).toBe(`${DEFAULT_CORE_URL}/api/auth/status`);
	expect(status?.authorization).toBe("Bearer local-owner");
	expect(
		seen.some((call) => call.url.startsWith("https://remote.example"))
	).toBe(false);
	const verify = seen.find((call) => call.url.endsWith("/api/step-up/verify"));
	expect(verify?.url).toBe("http://auth.test/api/step-up/verify");
	expect(verify?.authorization).toBe("Bearer core-session");
	expect(
		remote.calls.find((call) => call.path === "/api/step-up/verify")?.body
	).toEqual({ scope: "org.credentials", method: "totp", code: "123456" });
});

test("secrets confirm with a remote target falls back to the token the local Core minted", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "ryu-confirm-minted-"));
	try {
		await mkdir(join(dataDir, "secrets"), { recursive: true });
		await writeFile(
			join(dataDir, "secrets", "node-auth.token"),
			"minted-owner\n"
		);
		const remote = fakeNode(
			{
				"GET /api/auth/status": signedIn,
				"GET /api/step-up/status": {
					enrolmentRequired: false,
					methods: ["totp"],
					satisfied: true,
				},
			},
			"https://remote.example"
		);
		const { recorded, seen } = recordingUrls(remote.target);
		expect(
			await runCli(["secrets", "confirm"], {
				api: stubApi(),
				// The same bearer the identity broker gives `get`, `export` and `run`.
				env: { RYU_AUTH_URL: "http://auth.test", RYU_DIR: dataDir },
				io: makeIo().io,
				target: recorded,
			})
		).toBe(0);
		const status = seen.find((call) => call.url.endsWith("/api/auth/status"));
		expect(status?.url).toBe(`${DEFAULT_CORE_URL}/api/auth/status`);
		expect(status?.authorization).toBe("Bearer minted-owner");
	} finally {
		await rm(dataDir, { force: true, recursive: true });
	}
});

test("secrets confirm explains a forwarding tunnel and a refused local Core", async () => {
	const tunnel = makeIo();
	expect(
		await runCli(["secrets", "confirm", "123456"], {
			api: stubApi(),
			env: sessionEnv,
			io: tunnel.io,
			target: fakeNode({
				// What Core answers every caller while a forwarding tunnel runs.
				"GET /api/auth/status": { ...signedIn, token: null },
			}).target,
		})
	).toBe(1);
	expect(tunnel.err()).toContain("forwarding tunnel");
	expect(tunnel.err()).toContain("Stop the tunnel");
	expect(tunnel.err()).not.toContain("ryu login");

	const refused = makeIo();
	expect(
		await runCli(["secrets", "confirm", "123456"], {
			api: stubApi(),
			env: sessionEnv,
			io: refused.io,
			target: fakeNode({
				"GET /api/auth/status": () =>
					Response.json({ error: "unauthorized" }, { status: 401 }),
			}).target,
		})
	).toBe(1);
	expect(refused.err()).toContain("RYU_IDENTITY_CORE_TOKEN");
});

test("secrets confirm keeps a piped password as typed and reads a backup code", async () => {
	const routes = (methods: string[]) => ({
		"GET /api/auth/status": signedIn,
		"GET /api/step-up/status": {
			enrolmentRequired: false,
			methods,
			satisfied: false,
		},
		"POST /api/step-up/verify": {
			expiresAt: T,
			scope: "org.credentials",
			verified: true,
		},
	});
	const passwordNode = fakeNode(routes(["password"]));
	expect(
		await runCli(["secrets", "confirm", "--method", "password"], {
			api: stubApi(),
			env: sessionEnv,
			io: makeIo().io,
			readStdin: () => Promise.resolve("  pass word \n"),
			target: passwordNode.target,
		})
	).toBe(0);
	// Only the line ending the pipe added is dropped.
	expect(
		passwordNode.calls.find((call) => call.path === "/api/step-up/verify")?.body
	).toEqual({
		scope: "org.credentials",
		method: "password",
		code: "  pass word ",
	});

	const backupNode = fakeNode(routes(["otp", "totp", "backup"]));
	expect(
		await runCli(["secrets", "confirm", "abcd-efgh"], {
			api: stubApi(),
			env: sessionEnv,
			io: makeIo().io,
			target: backupNode.target,
		})
	).toBe(0);
	expect(
		backupNode.calls.find((call) => call.path === "/api/step-up/verify")?.body
	).toEqual({ scope: "org.credentials", method: "backup", code: "abcd-efgh" });
});
