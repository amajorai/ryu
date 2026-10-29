import { createHmac } from "node:crypto";
import { passwordSchema } from "@ryuhq/protocol/password-policy";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer, twoFactor } from "better-auth/plugins";

/**
 * Shared native-HTTP peer for the account-billing coverage suites.
 *
 * `/api/auth/*` is a REAL Better Auth server (the same 1.7 release the API
 * ships, with the same `bearer()` plugin and the production `twoFactor`
 * options from `packages/auth/src/index.ts`) over an in-memory adapter, so
 * sessions, password checks, TOTP enrollment, backup codes, session rotation
 * and email verification behave exactly as they do behind the desktop app.
 *
 * The control-plane routes the Account tab crosses (`/api/user/*`,
 * `/api/step-up/*`) are re-implemented here from their Hono handlers in
 * `packages/api/src/routers/user.ts` and the step-up library in
 * `packages/auth/src/lib/step-up.ts`, keyed on the real Better Auth session:
 * an account-security proof is one-use and bound to the session that proved
 * it, the factors offered follow `stepUpMethodsForScope`, and password proofs
 * are checked against the real credential hash.
 *
 * A credential account created by set-password carries the `issuer`
 * ("local:credential") that Better Auth 1.7 requires to find it at email
 * sign-in. The API handler writes it through Better Auth itself
 * (`auth.api.setPassword` for a first password, `internalAdapter.updatePassword`
 * for a change), so the real route and this peer agree on the stored shape; the
 * peer links the account with `internalAdapter.linkAccount` and the same issuer.
 *
 * Like the route, the peer's set-password checks the body (required, then the
 * sign-up rules in `passwordSchema`: eight to 128 characters with an uppercase
 * letter, a number and a symbol) before it spends the one-use proof.
 */

export interface PeerCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
	userId: string | null;
}

export interface EmailChangeRecord {
	createdAt: Date;
	id: string;
	newEmail: string;
	oldEmail: string;
	status: "cancelled" | "pending";
	userId: string;
}

export interface AccountPeer {
	auth: ReturnType<typeof createAuth>;
	calls: PeerCall[];
	emailChanges: EmailChangeRecord[];
	/** Simulates the person opening the emailed step-up link. */
	openMagicLink: () => void;
	origin: string;
	/** Magic-link step-up challenges waiting for a mailbox click. */
	pendingMagicLinks: Array<{ scope: string; sessionId: string }>;
	/** Arm one refusal for `METHOD /path` (served before the route runs). */
	refuseNext: (key: string, status: number, error: string) => void;
	stop: () => void;
	unknown: string[];
	/** Every verification mail Better Auth asked the host to send. */
	verificationMails: Array<{ email: string; url: string }>;
}

const SECRET = "account-billing-coverage-secret-2026-10-11-native";

function createAuth(baseURL: string, mails: AccountPeer["verificationMails"]) {
	return betterAuth({
		baseURL,
		secret: SECRET,
		database: memoryAdapter({
			account: [],
			session: [],
			twoFactor: [],
			user: [],
			verification: [],
		}),
		emailAndPassword: { enabled: true },
		emailVerification: {
			sendVerificationEmail: async ({ user, url }) => {
				mails.push({ email: user.email, url });
			},
		},
		plugins: [
			bearer(),
			twoFactor({
				issuer: "Ryu",
				backupCodesOptions: {
					amount: 10,
					length: 10,
					storeBackupCodes: "encrypted",
				},
			}),
		],
	});
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors `stepUpMethodsForScope(user, "account.security")`. */
function accountSecurityMethods(user: {
	hasPassword: boolean;
	twoFactorEnabled: boolean;
}): string[] {
	if (user.twoFactorEnabled) {
		return ["totp", "otp", "backup"];
	}
	return user.hasPassword ? ["password", "magic-link"] : ["magic-link"];
}

export function startAccountPeer(): AccountPeer {
	const calls: PeerCall[] = [];
	const unknown: string[] = [];
	const refusals = new Map<string, Array<{ error: string; status: number }>>();
	const emailChanges: EmailChangeRecord[] = [];
	const verificationMails: AccountPeer["verificationMails"] = [];
	const pendingMagicLinks: AccountPeer["pendingMagicLinks"] = [];
	/** Verified, unconsumed account-security proofs, by session id. */
	const proofs = new Set<string>();
	/** Public profile banner copies, by user id. */
	const banners = new Map<string, unknown>();
	let auth: ReturnType<typeof createAuth> | null = null;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const raw = request.method === "GET" ? "" : await request.clone().text();
			let body: unknown = null;
			try {
				body = raw ? JSON.parse(raw) : null;
			} catch {
				body = raw;
			}
			const call: PeerCall = {
				body,
				method: request.method,
				path: url.pathname + url.search,
				status: 0,
				userId: null,
			};
			calls.push(call);
			const reply = (payload: unknown, status = 200) => {
				call.status = status;
				return Response.json(payload, { status });
			};
			const refusal = refusals
				.get(`${request.method} ${url.pathname}`)
				?.shift();
			if (refusal) {
				return reply(
					{ error: refusal.error, message: refusal.error },
					refusal.status
				);
			}
			if (!auth) {
				return reply({ error: "Peer not ready" }, 503);
			}
			if (url.pathname.startsWith("/api/auth/")) {
				const response = await auth.handler(request);
				call.status = response.status;
				return response;
			}
			const session = await auth.api.getSession({ headers: request.headers });
			if (!session) {
				return reply({ error: "Unauthorized" }, 401);
			}
			call.userId = session.user.id;
			const context = await auth.$context;
			const accounts = await context.internalAdapter.findAccounts(
				session.user.id
			);
			const credential = accounts.find(
				(account) => account.providerId === "credential"
			);
			const hasPassword = Boolean(credential?.password);
			const twoFactorEnabled = Boolean(
				(session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled
			);
			const consumeProof = () => proofs.delete(session.session.id);
			const stepUpRequired = () =>
				reply(
					{
						action: "change your account security settings",
						enrolmentRequired: false,
						error: "STEP_UP_REQUIRED",
						message: "Verify your identity to continue",
						methods: accountSecurityMethods({ hasPassword, twoFactorEnabled }),
						scope: "account.security",
					},
					403
				);
			const route = `${request.method} ${url.pathname}`;

			if (route === "GET /api/step-up/status") {
				const scope = url.searchParams.get("scope");
				if (scope !== "account.security") {
					unknown.push(`step-up scope ${scope}`);
					return reply({ error: "Undeclared scope" }, 400);
				}
				return reply({
					action: "change your account security settings",
					enrolmentRequired: false,
					methods: accountSecurityMethods({ hasPassword, twoFactorEnabled }),
					satisfied: proofs.has(session.session.id),
					scope,
					twoFactorEnabled,
					windowMs: 300_000,
				});
			}
			if (route === "POST /api/step-up/challenge") {
				const input = body as { method?: string; scope?: string };
				if (
					input?.method === "magic-link" &&
					input.scope === "account.security"
				) {
					pendingMagicLinks.push({
						scope: input.scope,
						sessionId: session.session.id,
					});
					return reply({ ok: true });
				}
				unknown.push(`challenge ${JSON.stringify(body)}`);
				return reply({ error: "Undeclared challenge" }, 400);
			}
			if (route === "POST /api/step-up/verify") {
				const input = body as {
					code?: string;
					method?: string;
					scope?: string;
				};
				if (
					input?.scope !== "account.security" ||
					input.method !== "password"
				) {
					unknown.push(`verify ${JSON.stringify(body)}`);
					return reply({ error: "Undeclared verification" }, 400);
				}
				const ok =
					credential?.password && typeof input.code === "string"
						? await context.password.verify({
								hash: credential.password,
								password: input.code,
							})
						: false;
				if (!ok) {
					return reply({ error: "That password is incorrect." }, 400);
				}
				proofs.add(session.session.id);
				return reply({ ok: true });
			}
			if (route === "GET /api/user/password-status") {
				return reply({
					authMethod: credential?.password
						? "password"
						: (accounts[0]?.providerId ?? "magic-link"),
					hasPassword,
					provider: credential?.providerId ?? accounts[0]?.providerId ?? null,
				});
			}
			if (route === "GET /api/user/email-change-status") {
				const active = emailChanges
					.filter(
						(change) =>
							change.userId === session.user.id && change.status === "pending"
					)
					.at(-1);
				if (!active) {
					return reply({
						hasActive: false,
						message: "No active email change requests",
					});
				}
				return reply({
					emailChange: {
						createdAt: active.createdAt.toISOString(),
						id: active.id,
						newEmail: active.newEmail,
						newEmailConfirmedAt: null,
						oldEmail: active.oldEmail,
						oldEmailConfirmedAt: null,
						status: "pending",
						statusMessage: "Waiting for confirmation from both email addresses",
					},
					hasActive: true,
				});
			}
			if (route === "POST /api/user/initiate-email-change") {
				if (!consumeProof()) {
					return stepUpRequired();
				}
				const newEmail =
					typeof (body as { newEmail?: unknown })?.newEmail === "string"
						? ((body as { newEmail: string }).newEmail ?? "").trim()
						: "";
				if (!newEmail) {
					return reply({ error: "New email is required" }, 400);
				}
				if (!EMAIL_RE.test(newEmail)) {
					return reply({ error: "Invalid email format" }, 400);
				}
				if (newEmail.toLowerCase() === session.user.email.toLowerCase()) {
					return reply(
						{ error: "New email must be different from current email" },
						400
					);
				}
				if (
					await context.internalAdapter.findUserByEmail(newEmail.toLowerCase())
				) {
					return reply({ error: "This email address is already in use" }, 409);
				}
				if (
					emailChanges.some(
						(change) =>
							change.userId === session.user.id && change.status === "pending"
					)
				) {
					return reply(
						{
							error:
								"You already have a pending email change request. Please check your email or wait for the current request to expire.",
						},
						429
					);
				}
				emailChanges.push({
					createdAt: new Date(),
					id: `email-change-${emailChanges.length + 1}`,
					newEmail: newEmail.toLowerCase(),
					oldEmail: session.user.email,
					status: "pending",
					userId: session.user.id,
				});
				return reply({ success: true });
			}
			if (route === "POST /api/user/cancel-email-change") {
				const active = emailChanges.find(
					(change) =>
						change.userId === session.user.id && change.status === "pending"
				);
				if (!active) {
					return reply({ error: "No active email change request found" }, 404);
				}
				active.status = "cancelled";
				return reply({
					message: "Email change request cancelled successfully",
					success: true,
				});
			}
			if (route === "POST /api/user/set-password") {
				const newPassword = (body as { newPassword?: unknown })?.newPassword;
				if (typeof newPassword !== "string" || !newPassword) {
					return reply({ error: "New password is required" }, 400);
				}
				const policy = passwordSchema.safeParse(newPassword);
				if (!policy.success) {
					return reply(
						{
							error:
								policy.error.issues[0]?.message ?? "Choose a stronger password",
						},
						400
					);
				}
				if (!consumeProof()) {
					return stepUpRequired();
				}
				const hash = await context.password.hash(newPassword);
				if (credential) {
					await context.internalAdapter.updatePassword(session.user.id, hash);
				} else {
					await context.internalAdapter.linkAccount({
						accountId: session.user.id,
						issuer: "local:credential",
						password: hash,
						providerId: "credential",
						userId: session.user.id,
					});
				}
				return reply({
					action: credential?.password ? "changed" : "set",
					success: true,
				});
			}
			if (route === "PUT /api/profile/name") {
				// packages/api/src/routers/profile.ts
				const name = (body as { name?: unknown })?.name;
				if (typeof name !== "string" || !name) {
					return reply({ error: "Name is required and must be a string" }, 400);
				}
				if (name.trim().length === 0) {
					return reply({ error: "Name cannot be empty" }, 400);
				}
				if (name.length > 50) {
					return reply({ error: "Name cannot exceed 50 characters" }, 400);
				}
				await context.internalAdapter.updateUser(session.user.id, {
					name: name.trim(),
				});
				return reply({ name: name.trim(), success: true });
			}
			if (route === "GET /api/profile/me/profile") {
				return reply({
					bannerWallpaper: banners.get(session.user.id) ?? null,
				});
			}
			if (route === "PATCH /api/profile/me/banner-wallpaper") {
				const banner =
					(body as { bannerWallpaper?: unknown })?.bannerWallpaper ?? null;
				banners.set(session.user.id, banner);
				return reply({ bannerWallpaper: banner, ok: true });
			}
			unknown.push(`${route}`);
			return reply({ error: "Undeclared account contract" }, 404);
		},
	});
	const origin = server.url.origin;
	auth = createAuth(origin, verificationMails);
	return {
		auth,
		calls,
		emailChanges,
		openMagicLink: () => {
			const link = pendingMagicLinks.shift();
			if (link) {
				proofs.add(link.sessionId);
			}
		},
		origin,
		pendingMagicLinks,
		refuseNext: (key, status, error) => {
			refusals.set(key, [...(refusals.get(key) ?? []), { error, status }]);
		},
		stop: () => server.stop(true),
		unknown,
		verificationMails,
	};
}

/** Signs a user up through the real Better Auth server; returns the bearer. */
export async function signUp(
	peer: AccountPeer,
	input: { email: string; name: string; password: string }
): Promise<{ token: string; userId: string }> {
	const response = await peer.auth.api.signUpEmail({
		asResponse: true,
		body: input,
	});
	const token = response.headers.get("set-auth-token");
	const json = (await response.json()) as { user?: { id?: string } };
	if (!(token && json.user?.id)) {
		throw new Error(`Sign-up failed with ${response.status}`);
	}
	return { token, userId: json.user.id };
}

/** Creates a passwordless user who signs in with a linked provider. */
export async function createProviderUser(
	peer: AccountPeer,
	input: { email: string; name: string; providerId: string }
): Promise<{ token: string; userId: string }> {
	const context = await peer.auth.$context;
	// The same seam a GitHub (or other OAuth) sign-in uses: the user and its
	// provider account are created together, with no credential account.
	const { user } = await context.internalAdapter.createOAuthUser(
		{ email: input.email, emailVerified: true, name: input.name },
		{
			accountId: `${input.providerId}-${input.email}`,
			issuer: `local:oauth:${encodeURIComponent(input.providerId)}`,
			providerId: input.providerId,
		}
	);
	const session = await context.internalAdapter.createSession(user.id, false);
	// `bearer()` admits the raw session token (it signs it server-side), the
	// same value a native client stores after a provider sign-in.
	return { token: session.token, userId: user.id };
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of input.replace(/=+$/u, "").toUpperCase()) {
		const index = BASE32.indexOf(char);
		if (index < 0) {
			throw new Error(`Not a base32 setup key: ${input}`);
		}
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/**
 * An authenticator app's RFC 6238 code for a base32 setup key, computed
 * independently of Better Auth's own OTP helper.
 */
export function authenticatorCode(setupKey: string, at = Date.now()): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
	const digest = createHmac("sha1", base32Decode(setupKey))
		.update(counter)
		.digest();
	const offset = (digest.at(-1) ?? 0) & 0x0f;
	const binary = digest.readUInt32BE(offset) & 0x7f_ff_ff_ff;
	return String(binary % 1_000_000).padStart(6, "0");
}

export interface NodeCall {
	body: unknown;
	method: string;
	node: string | null;
	path: string;
	status: number;
}

export interface NodePeer {
	calls: NodeCall[];
	/** Holds the next matching request until the returned release is called. */
	hold: (node: string, method: string, path: string) => () => void;
	/** Raw preference values per node. */
	preferences: Record<string, Map<string, string>>;
	refuseNext: (
		node: string,
		method: string,
		path: string,
		status: number
	) => void;
	stop: () => void;
	tokenFor: (node: string) => string;
	unknown: string[];
	urlFor: (node: string) => string;
}

/**
 * Core node peers for the preference routes (`GET`/`PUT
 * /api/preferences/:key`, `apps/core/src/routes/preferences.rs`), one per
 * name, each demanding its own node bearer.
 */
export function startNodePeer(names: string[]): NodePeer {
	const calls: NodeCall[] = [];
	const unknown: string[] = [];
	const preferences = Object.fromEntries(
		names.map((name) => [name, new Map<string, string>()])
	);
	const holds = new Map<string, Promise<void>>();
	const refusals = new Map<string, number[]>();
	const tokenFor = (node: string) => `node-${node}-token`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const [, node = "", ...rest] = url.pathname.split("/");
			const path = `/${rest.join("/")}`;
			const raw = request.method === "GET" ? "" : await request.text();
			const call: NodeCall = {
				body: raw ? JSON.parse(raw) : null,
				method: request.method,
				node: names.includes(node) ? node : null,
				path,
				status: 0,
			};
			calls.push(call);
			const reply = (payload: unknown, status = 200) => {
				call.status = status;
				return Response.json(payload, { status });
			};
			if (
				!call.node ||
				request.headers.get("authorization") !== `Bearer ${tokenFor(node)}`
			) {
				unknown.push(`${request.method} ${url.pathname}: wrong node authority`);
				return reply({ error: "Wrong node authority" }, 401);
			}
			const key = `${node} ${request.method} ${path}`;
			const held = holds.get(key);
			if (held) {
				holds.delete(key);
				await held;
			}
			const refusal = refusals.get(key)?.shift();
			if (refusal) {
				return reply({ error: "Node refused the request" }, refusal);
			}
			const match = /^\/api\/preferences\/([^/]+)$/u.exec(path);
			const store = preferences[node];
			if (match && store) {
				const prefKey = decodeURIComponent(match[1] ?? "");
				if (request.method === "GET") {
					const value = store.get(prefKey);
					return value === undefined
						? reply({ error: "Preference not found" }, 404)
						: reply({ key: prefKey, value });
				}
				if (request.method === "PUT") {
					const value = (call.body as { value?: unknown })?.value;
					if (typeof value !== "string") {
						return reply({ error: "value must be a string" }, 400);
					}
					store.set(prefKey, value);
					return reply({ key: prefKey, value });
				}
			}
			unknown.push(`${request.method} ${url.pathname}`);
			return reply({ error: "Undeclared node contract" }, 404);
		},
	});
	const origin = server.url.origin;
	return {
		calls,
		hold: (node, method, path) => {
			let release: () => void = () => undefined;
			holds.set(
				`${node} ${method} ${path}`,
				new Promise<void>((resolve) => {
					release = resolve;
				})
			);
			return () => release();
		},
		preferences,
		refuseNext: (node, method, path, status) => {
			const key = `${node} ${method} ${path}`;
			refusals.set(key, [...(refusals.get(key) ?? []), status]);
		},
		stop: () => server.stop(true),
		tokenFor,
		unknown,
		urlFor: (node) => `${origin}/${node}`,
	};
}
