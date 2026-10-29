import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import { z } from "zod";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";
import { AUTH_BACKEND_URL } from "../core/authBackend.ts";
import { FRONTEND_URL } from "../core/waitlist.ts";

const TARGET = { url: "http://127.0.0.1:7980", token: null };
const realFetch = globalThis.fetch;

const originalAuthUrl = process.env.RYU_AUTH_URL;

beforeEach(() => {
	// These flows use a configured account service. The unconfigured loopback
	// default is never sent account credentials (core/authBackend.ts).
	process.env.RYU_AUTH_URL = AUTH_BACKEND_URL;
});

afterEach(() => {
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

function makeIo() {
	let out = "";
	let err = "";
	const io: CliIO = {
		out: (chunk) => {
			out += chunk;
		},
		err: (chunk) => {
			err += chunk;
		},
	};
	return { err: () => err, io, out: () => out };
}

function stubApi(call: CoreApi["call"]): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected Core API call"));
	return {
		call,
		disableApp: notCalled,
		enableApp: notCalled,
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
	};
}

interface AuthSessionFixture {
	createdAt: string;
	expiresAt: string;
	id: string;
	ipAddress: string;
	isCurrent?: unknown;
	userAgent: string;
	userId: string;
}

interface CallRecord {
	body?: z.infer<typeof appResponseValueSchema>;
	headers: Headers;
	method: string;
	origin: string;
	path: string;
}

const sessionsOutputFields = z.looseObject({
	sessions: z.array(
		z.looseObject({
			createdAt: z.string().optional(),
			expiresAt: z.string().optional(),
			id: z.string(),
			ipAddress: z.string().optional(),
			userAgent: z.string().optional(),
			userId: z.string().optional(),
		})
	),
});
const sessionsOutputSchema = z.custom<z.infer<typeof sessionsOutputFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		sessionsOutputFields.safeParse(value).success
);

function newerRemoteSessions() {
	const sessions = fixtureSessions().reverse();
	const first = sessions[0];
	if (first) {
		first.createdAt = "2026-10-08T08:00:00.000Z";
	}
	return sessions;
}

function fixtureSessions(): AuthSessionFixture[] {
	return [
		{
			id: "current-session",
			isCurrent: true,
			userId: "user-1",
			createdAt: "2026-10-01T08:00:00.000Z",
			expiresAt: "2026-10-08T08:00:00.000Z",
			userAgent: "Chrome/140.0.0.0",
			ipAddress: "192.0.2.10",
		},
		{
			id: "remote-session",
			isCurrent: false,
			userId: "user-1",
			createdAt: "2026-09-30T08:00:00.000Z",
			expiresAt: "2026-10-07T08:00:00.000Z",
			userAgent: "Firefox/142.0",
			ipAddress: "192.0.2.20",
		},
	];
}

function installAuthBackend(
	options: {
		failFirstSessionsRead?: boolean;
		sessions?: AuthSessionFixture[];
	} = {}
) {
	const calls: CallRecord[] = [];
	const sessions = [...(options.sessions ?? fixtureSessions())];
	let failFirstSessionsRead = options.failFirstSessionsRead ?? false;
	globalThis.fetch = Object.assign(
		async (
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			const body = init?.body
				? appResponseValueSchema.parse(JSON.parse(String(init.body)))
				: undefined;
			calls.push({
				body,
				headers: new Headers(init?.headers),
				method,
				origin: url.origin,
				path: url.pathname,
			});
			if (url.origin !== AUTH_BACKEND_URL) {
				return Response.json(
					{ error: `unexpected request to ${url.origin}` },
					{ status: 500 }
				);
			}
			if (url.pathname === "/api/auth/get-session") {
				return Response.json({
					user: {
						id: "user-1",
						name: "Taylor Person",
						email: "taylor@example.test",
						emailVerified: true,
						twoFactorEnabled: true,
						privateInternalField: "must not be printed",
					},
				});
			}
			if (url.pathname === "/api/user/password-status") {
				return Response.json({
					hasPassword: true,
					authMethod: "password",
					provider: null,
				});
			}
			if (url.pathname === "/api/billing/subscription-status") {
				return Response.json({
					subscription: { id: "sub-1", status: "active", interval: "month" },
				});
			}
			if (url.pathname === "/api/sessions" && method === "GET") {
				if (failFirstSessionsRead) {
					failFirstSessionsRead = false;
					return Response.json(
						{ error: "temporary sessions read failure" },
						{ status: 503 }
					);
				}
				return Response.json({ sessions });
			}
			if (url.pathname === "/api/sessions" && method === "DELETE") {
				const current = sessions.find(
					(session) => session.id === "current-session"
				);
				for (let index = sessions.length - 1; index >= 0; index -= 1) {
					if (sessions[index]?.id !== current?.id) {
						sessions.splice(index, 1);
					}
				}
				return Response.json({
					success: true,
					message: "All other sessions revoked",
				});
			}
			if (url.pathname.startsWith("/api/sessions/") && method === "DELETE") {
				const id = decodeURIComponent(
					url.pathname.slice("/api/sessions/".length)
				);
				const index = sessions.findIndex((session) => session.id === id);
				if (index < 0) {
					return Response.json({ error: "Session not found" }, { status: 404 });
				}
				if (sessions[index]?.id === "current-session") {
					return Response.json(
						{ error: "Cannot revoke current session" },
						{ status: 400 }
					);
				}
				sessions.splice(index, 1);
				return Response.json({ success: true, message: "Session revoked" });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
		{ preconnect: realFetch.preconnect }
	);
	return { calls, sessions };
}

function makeCore(
	status: z.infer<typeof appResponseValueSchema>,
	response?: z.infer<typeof appResponseValueSchema>
) {
	const calls: Array<{
		body?: z.infer<typeof appRequestValueSchema>;
		method?: string;
		path: string;
	}> = [];
	const api = stubApi(async (_target, path, options = {}) => {
		calls.push({
			body: appRequestValueSchema.parse(options.body),
			method: options.method,
			path,
		});
		if (path === "/api/auth/status") {
			return status;
		}
		if (path === "/api/auth/login") {
			return (
				response ?? {
					userCode: "ABCD-EFGH",
					verificationUri: "https://auth.example.test/device",
					verificationUriComplete:
						"https://auth.example.test/device?code=ABCD-EFGH",
				}
			);
		}
		if (path === "/api/auth/logout") {
			return response ?? { success: true, activeUserId: null };
		}
		throw new Error(`unexpected Core path ${path}`);
	});
	return { api, calls };
}

test("ryu login and logout use Core's device-flow routes and exact backend payload, with dry-run write guards", async () => {
	const core = makeCore({ authenticated: false, token: null });
	const loginIo = makeIo();
	const loginCode = await runCli(["login"], {
		api: core.api,
		io: loginIo.io,
		target: TARGET,
	});
	expect(loginCode).toBe(0);
	expect(core.calls).toEqual([
		{
			body: { backendUrl: AUTH_BACKEND_URL },
			method: "POST",
			path: "/api/auth/login",
		},
	]);
	expect(loginIo.out()).toContain("ABCD-EFGH");
	expect(loginIo.out()).toContain(
		"https://auth.example.test/device?code=ABCD-EFGH"
	);

	const dryRunIo = makeIo();
	await runCli(["login", "--dry-run"], {
		api: core.api,
		io: dryRunIo.io,
		target: TARGET,
	});
	expect(core.calls).toHaveLength(1);
	expect(dryRunIo.out()).toContain("Would start account sign-in.");

	const failedLoginCore = makeCore(
		{ authenticated: false, token: null },
		{ error: "device provider unavailable" }
	);
	const failedLoginIo = makeIo();
	const failedLoginCode = await runCli(["login"], {
		api: failedLoginCore.api,
		io: failedLoginIo.io,
		target: TARGET,
	});
	expect(failedLoginCode).toBe(1);
	expect(failedLoginIo.err()).toContain("device provider unavailable");

	const logoutIo = makeIo();
	const logoutCode = await runCli(["logout"], {
		api: core.api,
		io: logoutIo.io,
		target: TARGET,
	});
	expect(logoutCode).toBe(0);
	expect(core.calls.at(-1)).toEqual({
		method: "POST",
		path: "/api/auth/logout",
	});
	expect(logoutIo.out()).toContain("Signed out of the active account.");
	const logoutDryRun = makeIo();
	await runCli(["logout", "--dry-run"], {
		api: core.api,
		io: logoutDryRun.io,
		target: TARGET,
	});
	expect(core.calls).toHaveLength(2);
	expect(logoutDryRun.out()).toContain("Would sign out of the active account.");
});

test("ryu whoami, account, and plan use authenticated Better Auth read routes without exposing bearer tokens", async () => {
	const backend = installAuthBackend();
	const core = makeCore({ authenticated: true, token: "account-bearer" });
	const whoamiIo = makeIo();
	const whoamiCode = await runCli(["whoami"], {
		api: core.api,
		io: whoamiIo.io,
		target: TARGET,
	});
	expect(whoamiCode).toBe(0);
	expect(whoamiIo.out()).toContain("Taylor Person");
	expect(whoamiIo.out()).toContain("taylor@example.test");
	expect(whoamiIo.out()).not.toContain("must not be printed");
	expect(whoamiIo.out()).not.toContain("account-bearer");

	const accountIo = makeIo();
	const accountCode = await runCli(["account", "--json"], {
		api: core.api,
		io: accountIo.io,
		target: TARGET,
	});
	expect(accountCode).toBe(0);
	expect(
		appResponseValueSchema.parse(JSON.parse(accountIo.out()))
	).toMatchObject({
		name: "Taylor Person",
		email: "taylor@example.test",
		emailVerified: true,
		hasPassword: true,
		twoFactorEnabled: true,
		activeSessions: 2,
	});
	expect(accountIo.out()).not.toContain("account-bearer");

	const planIo = makeIo();
	const planCode = await runCli(["plan"], {
		api: core.api,
		io: planIo.io,
		target: TARGET,
	});
	expect(planCode).toBe(0);
	expect(planIo.out()).toContain("subscription");
	const backendGets = backend.calls.filter((call) => call.method === "GET");
	expect(backendGets.map((call) => call.path)).toContain(
		"/api/auth/get-session"
	);
	expect(backendGets.map((call) => call.path)).toContain(
		"/api/user/password-status"
	);
	expect(backendGets.map((call) => call.path)).toContain(
		"/api/billing/subscription-status"
	);
	expect(backendGets.map((call) => call.path)).toContain("/api/sessions");
	expect(
		backendGets.every(
			(call) => call.headers.get("authorization") === "Bearer account-bearer"
		)
	).toBe(true);
	expect(
		core.calls.filter((call) => call.path === "/api/auth/status")
	).toHaveLength(3);

	const failedBackend = installAuthBackend({ failFirstSessionsRead: true });
	const failedCore = makeCore({ authenticated: true, token: "account-bearer" });
	const failedListIo = makeIo();
	const failedListCode = await runCli(["sessions"], {
		api: failedCore.api,
		io: failedListIo.io,
		target: TARGET,
	});
	expect(failedListCode).toBe(1);
	expect(failedListIo.err()).toContain("503");
	expect(failedBackend.calls.map((call) => [call.method, call.path])).toEqual([
		["GET", "/api/sessions"],
	]);
	expect(failedBackend.calls.some((call) => call.method === "DELETE")).toBe(
		false
	);
});

test("ryu sessions lists, revokes an explicitly selected non-current session, and checks readback", async () => {
	const backend = installAuthBackend();
	const core = makeCore({ authenticated: true, token: "account-bearer" });
	const listIo = makeIo();
	const listCode = await runCli(["sessions", "--json"], {
		api: core.api,
		io: listIo.io,
		target: TARGET,
	});
	expect(listCode).toBe(0);
	expect(
		sessionsOutputSchema
			.parse(JSON.parse(listIo.out()))
			.sessions.map((session) => session.id)
	).toEqual(["current-session", "remote-session"]);
	expect(listIo.out()).not.toContain("token");

	const currentIo = makeIo();
	const currentCode = await runCli(["sessions", "revoke", "current-session"], {
		api: core.api,
		io: currentIo.io,
		target: TARGET,
	});
	expect(currentCode).toBe(1);
	expect(currentIo.err()).toContain(
		"current device's session cannot be revoked"
	);
	expect(backend.calls.some((call) => call.method === "DELETE")).toBe(false);

	const dryRunIo = makeIo();
	await runCli(["sessions", "revoke", "remote-session", "--dry-run"], {
		api: core.api,
		io: dryRunIo.io,
		target: TARGET,
	});
	expect(dryRunIo.out()).toContain("Would revoke session remote-session");
	expect(backend.calls.some((call) => call.method === "DELETE")).toBe(false);

	const revokeIo = makeIo();
	const revokeCode = await runCli(["sessions", "revoke", "remote-session"], {
		api: core.api,
		io: revokeIo.io,
		target: TARGET,
	});
	expect(revokeCode).toBe(0);
	expect(revokeIo.out()).toContain("revoked and confirmed");
	expect(backend.calls.filter((call) => call.method === "DELETE")).toEqual([
		{
			body: undefined,
			headers: expect.any(Headers),
			method: "DELETE",
			origin: AUTH_BACKEND_URL,
			path: "/api/sessions/remote-session",
		},
	]);
	expect(backend.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
	const revokeReadbacks = backend.calls.filter(
		(call) => call.method === "GET" && call.path === "/api/sessions"
	);
	expect(revokeReadbacks.length).toBeGreaterThanOrEqual(3);
});

test("ryu sessions revoke-all is no-write without force, previews safely, and preserves the current session", async () => {
	const backend = installAuthBackend();
	const core = makeCore({ authenticated: true, token: "account-bearer" });
	const refusedIo = makeIo();
	const refusedCode = await runCli(["sessions", "revoke-all"], {
		api: core.api,
		io: refusedIo.io,
		target: TARGET,
	});
	expect(refusedCode).toBe(2);
	expect(refusedIo.err()).toContain("--force");
	expect(backend.calls).toHaveLength(0);

	const previewIo = makeIo();
	const previewCode = await runCli(["sessions", "revoke-all", "--dry-run"], {
		api: core.api,
		io: previewIo.io,
		target: TARGET,
	});
	expect(previewCode).toBe(0);
	expect(previewIo.out()).toContain("Would revoke 1 other session");
	expect(backend.calls.some((call) => call.method === "DELETE")).toBe(false);

	const confirmedIo = makeIo();
	const confirmedCode = await runCli(["sessions", "revoke-all", "--force"], {
		api: core.api,
		io: confirmedIo.io,
		target: TARGET,
	});
	expect(confirmedCode).toBe(0);
	expect(confirmedIo.out()).toContain("this device remains signed in");
	expect(
		backend.calls
			.filter((call) => call.method === "DELETE")
			.map((call) => call.path)
	).toEqual(["/api/sessions"]);
	expect(backend.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
});

test("identity commands fail closed when Core cannot provide a verified local account bearer", async () => {
	const backend = installAuthBackend();
	const core = makeCore({ authenticated: true, token: null });
	const whoamiIo = makeIo();
	const whoamiCode = await runCli(["whoami"], {
		api: core.api,
		io: whoamiIo.io,
		target: TARGET,
	});
	expect(whoamiCode).toBe(1);
	expect(whoamiIo.err()).toContain("No local account session");
	const sessionsIo = makeIo();
	const sessionsCode = await runCli(["sessions"], {
		api: core.api,
		io: sessionsIo.io,
		target: TARGET,
	});
	expect(sessionsCode).toBe(1);
	expect(backend.calls).toHaveLength(0);
});

test("identity commands name the website setup page when the account must enroll a second factor", async () => {
	const backendPaths: string[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof realFetch>[0]) => {
			const url = new URL(String(input));
			backendPaths.push(`${url.origin}${url.pathname}`);
			return Response.json(
				{
					code: "mfa_enrollment_required",
					error: "Two-factor authentication is required",
				},
				{ status: 403 }
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	const setupUrl = `${FRONTEND_URL.replace(/\/+$/, "")}/settings/setup-2fa`;
	const core = makeCore({ authenticated: true, token: "account-bearer" });

	const human = makeIo();
	const humanCode = await runCli(["whoami"], {
		api: core.api,
		io: human.io,
		target: TARGET,
	});
	expect(humanCode).toBe(1);
	expect(backendPaths).toEqual([`${AUTH_BACKEND_URL}/api/auth/get-session`]);
	expect(human.out()).toBe("");
	expect(human.err()).toContain("Two-factor authentication required.");
	expect(human.err()).toContain(
		`Set one up at ${setupUrl}, then run this command again.`
	);
	expect(human.err()).not.toContain("failed: 403");
	expect(human.err().trimEnd().split("\n")).toHaveLength(1);

	const machine = makeIo();
	const machineCode = await runCli(["sessions", "--json"], {
		api: core.api,
		io: machine.io,
		target: TARGET,
	});
	expect(machineCode).toBe(1);
	expect(appResponseValueSchema.parse(JSON.parse(machine.err()))).toMatchObject(
		{
			code: "mfa_enrollment_required",
			setupUrl,
		}
	);
	expect(machine.err()).toContain("run this command again");
});

test("session identity protects the older current device and permits revoking the newer first row", async () => {
	const backend = installAuthBackend({ sessions: newerRemoteSessions() });
	const core = makeCore({ authenticated: true, token: "account-bearer" });
	const listing = makeIo();
	expect(
		await runCli(["sessions", "--json"], {
			api: core.api,
			io: listing.io,
			target: TARGET,
		})
	).toBe(0);
	expect(
		JSON.parse(listing.out()).sessions.map(
			(session: { id: string; isCurrent: boolean }) => [
				session.id,
				session.isCurrent,
			]
		)
	).toEqual([
		["remote-session", false],
		["current-session", true],
	]);
	const io = makeIo();
	expect(
		await runCli(["sessions", "revoke", "current-session"], {
			api: core.api,
			io: io.io,
			target: TARGET,
		})
	).toBe(1);
	expect(io.err()).toContain("current device's session cannot be revoked");
	expect(backend.calls.filter((call) => call.method === "DELETE")).toHaveLength(
		0
	);
	const remote = makeIo();
	expect(
		await runCli(["sessions", "revoke", "remote-session"], {
			api: core.api,
			io: remote.io,
			target: TARGET,
		})
	).toBe(0);
	expect(backend.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
	expect(
		backend.calls
			.filter((call) => call.method === "DELETE")
			.map((call) => call.path)
	).toEqual(["/api/sessions/remote-session"]);
});

test("revoke-all preserves flagged identity and never invents current identity from absent or malformed flags", async () => {
	const core = makeCore({ authenticated: true, token: "account-bearer" });
	const backend = installAuthBackend({ sessions: newerRemoteSessions() });
	const io = makeIo();
	expect(
		await runCli(["sessions", "revoke-all", "--force"], {
			api: core.api,
			io: io.io,
			target: TARGET,
		})
	).toBe(0);
	expect(backend.sessions.map((session) => session.id)).toEqual([
		"current-session",
	]);
	for (const flag of [undefined, "true", 1]) {
		const sessions = fixtureSessions();
		const first = sessions[0];
		if (first) {
			first.isCurrent = flag;
		}
		const unverified = installAuthBackend({ sessions });
		const result = makeIo();
		expect(
			await runCli(["sessions", "revoke-all", "--force"], {
				api: core.api,
				io: result.io,
				target: TARGET,
			})
		).toBe(1);
		expect(
			unverified.calls.filter((call) => call.method === "DELETE")
		).toHaveLength(0);
	}
});
