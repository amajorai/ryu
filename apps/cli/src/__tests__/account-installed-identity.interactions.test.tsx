/* @jsxImportSource @opentui/react */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { request } from "@ryuhq/core-client/client";
import { act } from "react";
import type { z } from "zod";
import { ThemeProvider } from "../../components/ui/theme-provider.tsx";
import { AUTH_BACKEND_URL } from "../core/authBackend.ts";
import {
	ContributionsProvider,
	useContributions,
} from "../core/ContributionsContext.tsx";
import { CoreProvider } from "../core/CoreContext.tsx";
import { fetchContributedContent } from "../core/contributions.ts";
import { CORE_IDENTITY_PATH, coreIdentityProof } from "../core/coreIdentity.ts";
import {
	disposeCliIdentity,
	installCliIdentity,
	refreshCliIdentityAfterAccountChange,
} from "../core/identity.ts";
import { accountSwitchResponseSchema } from "../overlays/settings/account-security-response-contracts.ts";
import { AccountTab } from "../tabs/account.tsx";
import { ToastHost, ToastProvider } from "../ui/toast.tsx";
import { testRender } from "./cli-test-render.ts";
import { useFetchBackedLoopback } from "./core-identity-fixture.ts";

interface DeferredIdentityBroker {
	release: (() => void) | null;
}
interface DeferredDeviceSignIn extends DeferredIdentityBroker {
	started: boolean;
}
interface InstalledIdentityRequestObservation {
	body: z.infer<typeof appResponseValueSchema>;
	identity: string | null;
	method: string;
	path: string;
}

const target = {
	url: "http://127.0.0.1:7980",
	token: "account-identity-synthetic-node",
};
const realFetch = globalThis.fetch;

// The node's loopback connections go to this file's fetch stub, not sockets.
let restoreLoopback: (() => void) | null = null;
beforeAll(() => {
	restoreLoopback = useFetchBackedLoopback();
});
afterAll(() => {
	restoreLoopback?.();
});

/** The synthetic Core proves it holds the node token before the CLI's broker
 *  exchange sends it (see core/coreIdentity.ts). */
function answerCoreIdentity(url: URL): Response | null {
	if (url.origin !== target.url || url.pathname !== CORE_IDENTITY_PATH) {
		return null;
	}
	const nonce = url.searchParams.get("nonce") ?? "";
	return Response.json({
		proof: coreIdentityProof(
			target.token,
			url.hostname,
			Number(url.port),
			nonce
		),
	});
}
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | null = null;
let ownedHome: string | null = null;
const originalEnvironment = {
	RYU_CLI_CONFIG_DIR: process.env.RYU_CLI_CONFIG_DIR,
	RYU_IDENTITY_CORE_URL: process.env.RYU_IDENTITY_CORE_URL,
	RYU_IDENTITY_CORE_TOKEN: process.env.RYU_IDENTITY_CORE_TOKEN,
};

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

afterEach(async () => {
	await act(async () => setup?.renderer.destroy());
	setup = null;
	globalThis.fetch = realFetch;
	disposeCliIdentity();
	for (const [name, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
	if (ownedHome) {
		rmSync(ownedHome, { recursive: true, force: true });
		ownedHome = null;
	}
});

function PublishedContributions() {
	const { views, slashCommands, reload } = useContributions();
	useKeyboard((key) => {
		if (key.name === "f") {
			reload();
		}
	});
	return (
		<box flexDirection="column" flexShrink={0} height={3}>
			<text
				flexShrink={0}
				height={1}
			>{`Published views: ${views.map((view) => view.title).join(",")}`}</text>
			<text
				flexShrink={0}
				height={1}
			>{`Published commands: ${slashCommands.map((command) => command.name).join(",")}`}</text>
		</box>
	);
}

test("an obsolete broker completion cannot restore account A after the actual installed source refreshes account B", async () => {
	ownedHome = mkdtempSync(join(tmpdir(), "ryu-cli-installed-broker-race-"));
	process.env.RYU_CLI_CONFIG_DIR = join(ownedHome, ".ryu");
	process.env.RYU_IDENTITY_CORE_URL = target.url;
	process.env.RYU_IDENTITY_CORE_TOKEN = target.token;
	let activeAccount: "a" | "b" = "a";
	let brokerCalls = 0;
	const obsolete: DeferredIdentityBroker = { release: null };
	const unknown: string[] = [];
	const calls: InstalledIdentityRequestObservation[] = [];
	const expiresAt = Math.floor(Date.now() / 1000) + 900;
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const req = input instanceof Request ? input : null;
			const url = new URL(req?.url ?? String(input));
			const identityAnswer = answerCoreIdentity(url);
			if (identityAnswer) {
				return identityAnswer;
			}
			const method = init?.method ?? req?.method ?? "GET";
			const headers = new Headers(init?.headers ?? req?.headers);
			const body =
				init?.body == null
					? null
					: appResponseValueSchema.parse(JSON.parse(String(init.body)));
			calls.push({
				path: url.pathname,
				method,
				identity: headers.get("x-ryu-user-jwt"),
				body,
			});
			if (
				url.origin === target.url &&
				!url.search &&
				req?.body == null &&
				headers.get("authorization") === `Bearer ${target.token}`
			) {
				if (
					method === "GET" &&
					url.pathname === "/api/auth/user-jwt" &&
					body === null
				) {
					brokerCalls += 1;
					if (brokerCalls === 2) {
						return await new Promise<Response>((resolve) => {
							obsolete.release = () =>
								resolve(
									Response.json({ token: "synthetic-broker-a", expiresAt })
								);
						});
					}
					return Response.json({
						token: `synthetic-broker-${activeAccount}`,
						expiresAt,
					});
				}
				if (method === "POST" && url.pathname === "/api/auth/accounts/switch") {
					expect(body).toEqual({ userId: "b" });
					activeAccount = "b";
					return Response.json({ success: true });
				}
				if (
					method === "GET" &&
					url.pathname === "/api/plugins/contributions" &&
					body === null
				) {
					return Response.json({ views: [], slash_commands: [] });
				}
			}
			unknown.push(`${method} ${url.href}`);
			throw new Error(
				`Unexpected stale broker fixture request: ${method} ${url.href}`
			);
		},
		{ preconnect: realFetch.preconnect }
	);
	const source = await installCliIdentity(target);
	expect(source.current()).toBe("synthetic-broker-a");
	source.clear();
	const oldRefresh = source.refresh();
	// The broker exchange first clears the (cached) Core identity gate, so the
	// held request starts a few microtasks later rather than synchronously.
	for (let turn = 0; turn < 20 && brokerCalls < 2; turn += 1) {
		await Promise.resolve();
	}
	expect(brokerCalls).toBe(2);
	expect(
		await request(
			target,
			"/api/auth/accounts/switch",
			{
				method: "POST",
				body: { userId: "b" },
			},
			accountSwitchResponseSchema
		)
	).toEqual({ success: true });
	await refreshCliIdentityAfterAccountChange();
	expect(source.current()).toBe("synthetic-broker-b");
	const release = obsolete.release;
	if (!release) {
		throw new Error("Obsolete real broker request was not held");
	}
	release();
	expect(await oldRefresh).toBeNull();
	expect(source.current()).toBe("synthetic-broker-b");
	await fetchContributedContent(target);
	expect(calls.at(-1)?.identity).toBe("synthetic-broker-b");
	expect(calls.map((call) => [call.method, call.path])).toEqual([
		["GET", "/api/auth/user-jwt"],
		["GET", "/api/auth/user-jwt"],
		["POST", "/api/auth/accounts/switch"],
		["GET", "/api/auth/user-jwt"],
		["GET", "/api/plugins/contributions"],
	]);
	expect(unknown).toEqual([]);
});

async function press(
	rendered: Setup,
	name: string,
	shift = false
): Promise<void> {
	const input = rendered.renderer.keyInput;
	await act(async () => {
		input.emit(
			"keypress",
			new KeyEvent({
				name,
				sequence: name,
				shift,
				ctrl: false,
				meta: false,
				option: false,
				eventType: "press",
				repeated: false,
				number: false,
				raw: name,
				source: "raw",
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await rendered.renderOnce();
	});
}

async function frameUntil(
	rendered: Setup,
	predicate: (frame: string) => boolean
): Promise<string> {
	let frame = rendered.captureCharFrame();
	const deadline = performance.now() + 2000;
	await act(async () => {
		while (!predicate(frame) && performance.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await rendered.renderOnce();
			frame = rendered.captureCharFrame();
		}
	});
	if (!predicate(frame)) {
		throw new Error(
			`Installed account identity did not reach expected frame:\n${frame}`
		);
	}
	return frame;
}

for (const action of [
	"switch",
	"logout",
	"remove-active",
	"remove-inactive",
	"device-login",
] as const) {
	test(`actual Account ${action} invalidates its installed broker identity only after successful mutation and refreshes canonical contribution reads`, async () => {
		ownedHome = mkdtempSync(
			join(tmpdir(), "ryu-cli-installed-account-identity-")
		);
		process.env.RYU_CLI_CONFIG_DIR = join(ownedHome, ".ryu");
		process.env.RYU_IDENTITY_CORE_URL = target.url;
		process.env.RYU_IDENTITY_CORE_TOKEN = target.token;
		let activeAccount: "a" | "b" | null = "a";
		let mutationAttempts = 0;
		let savedAccounts: ("a" | "b")[] = ["a", "b"];
		const expectedActive =
			action === "logout" ? null : action === "remove-inactive" ? "a" : "b";
		const expectedPath =
			action === "switch"
				? "/api/auth/accounts/switch"
				: action === "logout"
					? "/api/auth/logout"
					: action === "device-login"
						? "/api/auth/login"
						: "/api/auth/accounts/remove";
		const expectedBody =
			action === "logout"
				? null
				: action === "device-login"
					? { backendUrl: AUTH_BACKEND_URL }
					: { userId: action === "remove-active" ? "a" : "b" };
		const actionKey =
			action === "switch"
				? "s"
				: action === "logout"
					? "l"
					: action === "device-login"
						? "a"
						: "x";
		const device: DeferredDeviceSignIn = {
			started: false,
			release: null,
		};
		const broker: DeferredIdentityBroker = { release: null };
		const calls: InstalledIdentityRequestObservation[] = [];
		const unknown: string[] = [];
		const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
		const account = (id: "a" | "b") => ({
			userId: id,
			email: `${id}@example.test`,
			name: `Account ${id.toUpperCase()}`,
			active: id === activeAccount,
		});
		const contributionBody = (identity: string | null) => {
			const id =
				identity === "synthetic-broker-a"
					? "a"
					: identity === "synthetic-broker-b"
						? "b"
						: null;
			return {
				views: id
					? [
							{
								id: "surface:calendar",
								plugin: `com.example.${id}`,
								title: `Account ${id.toUpperCase()} private calendar`,
								view: "list-detail",
								spec: { view: "list-detail", items: [] },
							},
						]
					: [],
				slash_commands: id
					? [
							{
								command: `${id}-private-command`,
								plugin: `com.example.${id}`,
								description: `Account ${id.toUpperCase()} action`,
							},
						]
					: [],
			};
		};
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = input instanceof Request ? input : null;
				const url = new URL(request?.url ?? String(input));
				const identityAnswer = answerCoreIdentity(url);
				if (identityAnswer) {
					return identityAnswer;
				}
				const method = init?.method ?? request?.method ?? "GET";
				const headers = new Headers(init?.headers ?? request?.headers);
				const identity = headers.get("x-ryu-user-jwt");
				const body =
					init?.body == null
						? null
						: appResponseValueSchema.parse(JSON.parse(String(init.body)));
				const record = { method, path: url.pathname, identity, body };
				calls.push(record);
				const refuseUnknown = () => {
					unknown.push(`${method} ${url.href}`);
					throw new Error(
						`Unexpected installed identity request: ${method} ${url.href}`
					);
				};
				if (url.search || request?.body != null) {
					return refuseUnknown();
				}
				if (url.origin === target.url) {
					if (headers.get("authorization") !== `Bearer ${target.token}`) {
						return refuseUnknown();
					}
					if (method === "GET" && body === null) {
						if (url.pathname === "/api/auth/user-jwt") {
							if (activeAccount === "b") {
								return await new Promise<Response>((resolve) => {
									broker.release = () =>
										resolve(
											Response.json({ token: "synthetic-broker-b", expiresAt })
										);
								});
							}
							return Response.json(
								activeAccount
									? { token: `synthetic-broker-${activeAccount}`, expiresAt }
									: { token: null }
							);
						}
						if (url.pathname === "/api/auth/status") {
							if (device.started) {
								return await new Promise<Response>((resolve) => {
									device.release = () => {
										device.started = false;
										activeAccount = "b";
										resolve(
											Response.json({
												authenticated: true,
												pending: false,
												userCode: null,
												verificationUri: null,
												token: "synthetic-session-b",
											})
										);
									};
								});
							}
							return Response.json({
								authenticated: activeAccount !== null,
								pending: false,
								userCode: null,
								verificationUri: null,
								token: activeAccount
									? `synthetic-session-${activeAccount}`
									: null,
							});
						}
						if (url.pathname === "/api/auth/accounts") {
							return Response.json({
								activeUserId: activeAccount,
								accounts: savedAccounts.map(account),
							});
						}
						if (url.pathname === "/api/plugins/contributions") {
							return Response.json(contributionBody(identity));
						}
						if (
							[
								"/api/preferences/terminal-theme",
								"/api/preferences/theme",
							].includes(url.pathname)
						) {
							return Response.json({ value: JSON.stringify("dark") });
						}
					}
					if (method === "POST" && url.pathname === expectedPath) {
						expect<typeof body | typeof expectedBody>(body).toEqual(
							expectedBody
						);
						mutationAttempts += 1;
						if (mutationAttempts === 1) {
							return Response.json(
								{ error: "synthetic account mutation refused" },
								{ status: 503 }
							);
						}
						if (mutationAttempts !== 2) {
							return refuseUnknown();
						}
						if (action === "device-login") {
							device.started = true;
							// No URL is returned: actual browser/device authorization stays
							// outside this finite Core-observer regression.
							return Response.json({ userCode: "SYNTHETIC-DEVICE-CODE" });
						}
						activeAccount = expectedActive;
						if (action === "remove-active" || action === "remove-inactive") {
							savedAccounts = savedAccounts.filter(
								(id) => id !== (action === "remove-active" ? "a" : "b")
							);
						}
						return Response.json({ success: true });
					}
					return refuseUnknown();
				}
				if (
					url.origin === new URL(AUTH_BACKEND_URL).origin &&
					method === "GET" &&
					body === null
				) {
					const session = headers.get("authorization");
					const id =
						session === "Bearer synthetic-session-a"
							? "a"
							: session === "Bearer synthetic-session-b"
								? "b"
								: null;
					if (!id) {
						return refuseUnknown();
					}
					if (url.pathname === "/api/auth/get-session") {
						return Response.json({
							user: {
								id,
								name: `Account ${id.toUpperCase()}`,
								email: `${id}@example.test`,
								emailVerified: true,
								createdAt: "2026-01-01T00:00:00.000Z",
								updatedAt: "2026-01-01T00:00:00.000Z",
								twoFactorEnabled: false,
								image: null,
								avatarId: null,
								resendContactId: null,
								emailVerifiedAt: null,
								lastEmailSentAt: null,
								dailyEmailCount: null,
								lastEmailResetDate: null,
								referralCode: null,
								referredBy: null,
								referralCount: null,
								profileVisibility: null,
								username: null,
								displayUsername: null,
								isAnonymous: null,
								role: null,
								banned: null,
								banReason: null,
								banExpires: null,
							},
							session: {
								id: `session-${id}`,
								userId: id,
								token: `synthetic-session-${id}`,
								ipAddress: null,
								userAgent: null,
								impersonatedBy: null,
								activeOrganizationId: null,
								activeTeamId: null,
								expiresAt: "2027-01-01T00:00:00.000Z",
								createdAt: "2026-01-01T00:00:00.000Z",
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						});
					}
					if (url.pathname === "/api/user/password-status") {
						return Response.json({
							hasPassword: true,
							provider: "credential",
							authMethod: "credential",
						});
					}
					if (url.pathname === "/api/billing/subscription-status") {
						return Response.json({ subscription: null });
					}
					if (url.pathname === "/api/sessions") {
						return Response.json({
							sessions: [
								{
									id: `session-${id}`,
									userId: id,
									createdAt: "2026-01-01T00:00:00.000Z",
									expiresAt: "2027-01-01T00:00:00.000Z",
								},
							],
						});
					}
					if (url.pathname === "/api/user/email-change-status") {
						return Response.json({ emailChange: null });
					}
				}
				return refuseUnknown();
			},
			{ preconnect: realFetch.preconnect }
		);
		const source = await installCliIdentity(target);
		expect(source.current()).toBe("synthetic-broker-a");
		setup = await testRender(
			<ThemeProvider reducedMotion>
				<CoreProvider initial={target}>
					<ToastProvider>
						<ContributionsProvider>
							<box flexDirection="column" height={44}>
								<box flexDirection="column" flexShrink={0} height={32}>
									<AccountTab active />
								</box>
								<PublishedContributions />
								<ToastHost />
							</box>
						</ContributionsProvider>
					</ToastProvider>
				</CoreProvider>
			</ThemeProvider>,
			{ width: 140, height: 44 }
		);
		const rendered = setup;
		await frameUntil(
			rendered,
			(frame) =>
				frame.includes("Account A private calendar") &&
				frame.includes("a-private-command") &&
				frame.includes("b@example.test")
		);
		if (action === "switch" || action === "remove-inactive") {
			await press(rendered, "down");
		}
		await press(rendered, actionKey, action === "logout");
		await frameUntil(
			rendered,
			(frame) => mutationAttempts === 1 && frame.includes("503")
		);
		expect(activeAccount).toBe("a");
		const beforeRetry = await fetchContributedContent(target);
		expect(beforeRetry.views.map((view) => view.title)).toEqual([
			"Account A private calendar",
		]);
		expect(source.current()).toBe("synthetic-broker-a");
		expect(
			calls.filter((call) => call.path === "/api/auth/user-jwt")
		).toHaveLength(1);
		await press(rendered, actionKey, action === "logout");
		if (action === "device-login") {
			await frameUntil(
				rendered,
				(frame) =>
					mutationAttempts === 2 && frame.includes("SYNTHETIC-DEVICE-CODE")
			);
			expect(source.current()).toBe("synthetic-broker-a");
			await frameUntil(rendered, () => device.release !== null);
			const completeDevice = device.release;
			if (!completeDevice) {
				throw new Error("Real device-login observer did not poll Core status");
			}
			await act(async () => completeDevice());
		}
		await frameUntil(
			rendered,
			() => mutationAttempts === 2 && activeAccount === expectedActive
		);
		if (expectedActive === "b") {
			const pending = await frameUntil(
				rendered,
				(frame) =>
					broker.release !== null &&
					!frame.includes("Account A private calendar") &&
					!frame.includes("a-private-command")
			);
			expect(pending).not.toContain("Account A private calendar");
			expect(source.current()).toBeNull();
			expect((await fetchContributedContent(target)).views).toEqual([]);
			const release = broker.release;
			if (!release) {
				throw new Error(
					"Actual account switch did not request fresh broker identity"
				);
			}
			await act(async () => release());
		}
		await frameUntil(rendered, (frame) =>
			expectedActive
				? frame
						.split("\n")
						.some(
							(line) =>
								line.includes(`${expectedActive}@example.test`) &&
								line.includes("✓ active")
						)
				: !(frame.includes("✓ active") || frame.includes("Active account"))
		);
		// Canonical reader must stop forwarding A immediately after an actual successful
		// account mutation. Broker fixture mints the next identity; no target JWT is injected.
		const afterMutation = await fetchContributedContent(target);
		const expectedIdentity = expectedActive
			? `synthetic-broker-${expectedActive}`
			: null;
		expect(
			calls.filter((call) => call.path === "/api/plugins/contributions").at(-1)
				?.identity
		).toBe(expectedIdentity);
		expect(afterMutation.views.map((view) => view.title)).toEqual(
			expectedActive
				? [`Account ${expectedActive.toUpperCase()} private calendar`]
				: []
		);
		await press(rendered, "f");
		const recovered = await frameUntil(rendered, (frame) =>
			expectedActive
				? frame.includes(
						`Account ${expectedActive.toUpperCase()} private calendar`
					) &&
					frame.includes(`${expectedActive}-private-command`) &&
					(expectedActive === "a" ||
						!frame.includes("Account A private calendar"))
				: !(
						frame.includes("Account A private calendar") ||
						frame.includes("a-private-command")
					) && frame.includes("Published views:")
		);
		if (expectedActive !== "a") {
			expect(recovered).not.toContain("Account A private calendar");
		}
		if (action === "remove-active") {
			expect(recovered).not.toContain("a@example.test");
		}
		if (action === "remove-inactive") {
			expect(recovered).not.toContain("b@example.test");
			expect(source.current()).toBe("synthetic-broker-a");
		}
		expect(mutationAttempts).toBe(2);
		expect(
			calls.filter((call) => call.path === "/api/auth/user-jwt")
		).toHaveLength(2);
		expect<
			(InstalledIdentityRequestObservation["body"] | typeof expectedBody)[][]
		>(
			calls
				.filter((call) => call.method === "POST")
				.map((call) => [call.path, call.body])
		).toEqual([
			[expectedPath, expectedBody],
			[expectedPath, expectedBody],
		]);
		expect(unknown).toEqual([]);
	});
}
