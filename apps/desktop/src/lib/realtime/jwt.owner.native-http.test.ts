// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";

// Actual vault helpers and JWT consumers, with an invocation-owned HTTP peer.
// Signed mint fixtures do not establish Better Auth issuance, Core JWKS
// authorization, a native keychain, full AuthContext logout, or ChatPage proof.
const nativeFetch = globalThis.fetch;
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const NativeReadableStream = globalThis.ReadableStream;
const nativeResponseJson = NativeResponse.prototype.json;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const ownsDom = globalThis.document === undefined;
if (ownsDom) {
	GlobalRegistrator.register();
}
const registeredAbortController = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortController"
);
const registeredAbortSignal = Object.getOwnPropertyDescriptor(
	globalThis,
	"AbortSignal"
);
Object.defineProperty(globalThis, "AbortController", {
	configurable: true,
	writable: true,
	value: NativeAbortController,
});
Object.defineProperty(globalThis, "AbortSignal", {
	configurable: true,
	writable: true,
	value: NativeAbortSignal,
});

const authKeys = new Set([
	"ryu_accounts",
	"ryu_active_user_id",
	"ryu_session_token",
	"ryu_waitlist_approved",
	// Account lifecycle: a sign-out marks visible synced settings as owned by
	// no account, so the next account cannot adopt them.
	"ryu:settings-sync-visible-owner",
]);
function storageEntries() {
	const entries: [string, string][] = [];
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key !== null) {
			entries.push([key, localStorage.getItem(key)!]);
		}
	}
	return entries.sort(([left], [right]) => left.localeCompare(right));
}
const originalStorage = storageEntries();
for (const key of authKeys) {
	localStorage.removeItem(key);
}

const accounts = {
	a: {
		token: "jwt-owner-session-a",
		userId: "jwt-owner-user-a",
		email: "a@jwt-owner.example.test",
		name: "JWT owner A",
		image: null,
		isAnonymous: false,
	},
	b: {
		token: "jwt-owner-session-b",
		userId: "jwt-owner-user-b",
		email: "b@jwt-owner.example.test",
		name: "JWT owner B",
		image: null,
		isAnonymous: false,
	},
} as const;
type Owner = keyof typeof accounts;
interface Mint {
	holdBody: boolean;
	owner: Owner;
	status: 200 | 503;
	token: string;
}
interface Call {
	authorization: string | null;
	body: string;
	bodyCancelled: boolean;
	bodyComplete: boolean;
	buyer: string | null;
	contentType: string | null;
	delegation: string | null;
	id: number;
	method: string;
	owner: Owner | null;
	path: string;
	ryuHeaders: [string, string][];
	status: number;
}
interface BodyRead {
	body: unknown;
	id: number;
	status: number;
}
const calls: Call[] = [];
const bodyReads: BodyRead[] = [];
const unexpected: string[] = [];
const transportErrors: string[] = [];
const holds = new Map<number, () => void>();
const mintPlans = new Map<Owner, Mint[]>();
const consumerPromises = new Set<Promise<unknown>>();
const exchanges = new Set<Promise<Response>>();
const decoding = new Map<Promise<unknown>, number>();
const awaitingDecoder = new Set<number>();
const waiters = new Set<() => void>();
let activeHandlers = 0;
let nextCallId = 0;
let caseStart = 0;
let diagnosticCase = 0;
let protectedStorage: [string, string][] = [];
const artifactDirectory = process.env.RYU_REALTIME_JWT_PROOF_ARTIFACTS;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function notifyChange() {
	for (const wake of [...waiters]) {
		wake();
	}
}
function waitForChange(label: string) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			waiters.delete(wake);
			reject(new Error(label));
		}, 4000);
		const wake = () => {
			clearTimeout(timer);
			waiters.delete(wake);
			resolve();
		};
		waiters.add(wake);
	});
}
async function until(predicate: () => boolean, label: string) {
	while (!predicate()) {
		await waitForChange(label);
	}
}
function observe<T>(promise: Promise<T>): Promise<T> {
	consumerPromises.add(promise);
	const finished = () => {
		consumerPromises.delete(promise);
		notifyChange();
	};
	void promise.then(finished, (error: unknown) => {
		transportErrors.push(`JWT consumer rejected: ${String(error)}`);
		finished();
	});
	return promise;
}
function plan(
	owner: Owner,
	jti: string,
	holdBody = false,
	status: 200 | 503 = 200
): Mint {
	const issuedAt = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "jwt-owner-fixture" })
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iss: "jwt-owner-native-http-fixture",
			sub: accounts[owner].userId,
			id: accounts[owner].userId,
			iat: issuedAt,
			exp: issuedAt + 600,
			jti,
		})
	).toString("base64url");
	const signedBytes = Buffer.from(`${header}.${payload}`);
	const signature = sign(null, signedBytes, privateKey);
	expect(verify(null, signedBytes, publicKey, signature)).toBe(true);
	const mint = {
		owner,
		status,
		token: `${header}.${payload}.${signature.toString("base64url")}`,
		holdBody,
	};
	mintPlans.set(owner, [...(mintPlans.get(owner) ?? []), mint]);
	return mint;
}
function tokenCalls(owner?: Owner) {
	return calls
		.slice(caseStart)
		.filter(
			(call) =>
				call.path === "/api/auth/token" && (!owner || call.owner === owner)
		);
}
function consumeHeldBody(call: Call) {
	const release = holds.get(call.id);
	if (!release) {
		throw new Error(`No actual held body for request ${call.id}`);
	}
	release();
}
async function heldToken(owner: Owner) {
	await until(
		() =>
			tokenCalls(owner).some(
				(call) => holds.has(call.id) && [...decoding.values()].includes(call.id)
			),
		`No admitted ${owner} token GET with an actual pending native JSON body`
	);
	const call = tokenCalls(owner).find((candidate) => holds.has(candidate.id))!;
	expect(call).toMatchObject({
		owner,
		method: "GET",
		path: "/api/auth/token",
		authorization: `Bearer ${accounts[owner].token}`,
		delegation: null,
		buyer: null,
		ryuHeaders: [],
		contentType: null,
		body: "",
		status: 200,
		bodyComplete: false,
		bodyCancelled: false,
	});
	return call;
}
async function acknowledgedToken(owner: Owner, token: string) {
	await until(
		() =>
			tokenCalls(owner).some((call) =>
				bodyReads.some(
					(read) =>
						read.id === call.id &&
						read.status === 200 &&
						z.strictObject({ token: z.literal(token) }).safeParse(read.body)
							.success
				)
			),
		`No independently consumed ${owner} token response body`
	);
}
function assertProtectedStorage() {
	expect(storageEntries().filter(([key]) => !authKeys.has(key))).toEqual(
		protectedStorage
	);
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		activeHandlers += 1;
		const url = new URL(request.url);
		const bearer = request.headers.get("authorization");
		const owner =
			(Object.keys(accounts) as Owner[]).find(
				(key) => bearer === `Bearer ${accounts[key].token}`
			) ?? null;
		const call: Call = {
			id: ++nextCallId,
			owner,
			method: request.method,
			path: url.pathname + url.search,
			authorization: bearer,
			delegation: request.headers.get("x-ryu-user-jwt"),
			buyer: request.headers.get("x-ryu-buyer-token"),
			contentType: request.headers.get("content-type"),
			ryuHeaders: [...request.headers].filter(([key]) =>
				key.toLowerCase().startsWith("x-ryu-")
			),
			body: "",
			status: 0,
			bodyComplete: false,
			bodyCancelled: false,
		};
		calls.push(call);
		const reply = (body: unknown, status = 200) => {
			call.status = status;
			call.bodyComplete = true;
			notifyChange();
			return NativeResponse.json(body, {
				status,
				headers: { "x-jwt-owner-call": String(call.id) },
			});
		};
		const refuse = (reason: string) => {
			unexpected.push(reason);
			return reply({ error: reason }, 422);
		};
		try {
			call.body = await request.text();
			if (
				url.origin !== server.url.origin ||
				request.method !== "GET" ||
				url.search !== "" ||
				!owner ||
				call.body !== "" ||
				call.contentType !== null ||
				call.ryuHeaders.length !== 0
			) {
				return refuse(
					`Undeclared mint admission ${request.method} ${request.url}`
				);
			}
			if (url.pathname === "/api/auth/get-session") {
				const account = accounts[owner];
				return reply({
					user: {
						id: account.userId,
						email: account.email,
						name: account.name,
						image: null,
						isAnonymous: false,
						emailVerified: true,
						createdAt: "2026-10-09T00:00:00.000Z",
						updatedAt: "2026-10-09T00:00:00.000Z",
					},
					session: {
						id: `jwt-owner-profile-${owner}`,
						token: account.token,
						userId: account.userId,
						createdAt: "2026-10-09T00:00:00.000Z",
						updatedAt: "2026-10-09T00:00:00.000Z",
						expiresAt: "2027-10-09T00:00:00.000Z",
						ipAddress: null,
						userAgent: null,
					},
				});
			}
			if (url.pathname !== "/api/auth/token") {
				return refuse(`Undeclared mint path ${url.pathname}`);
			}
			const mint = mintPlans.get(owner)?.shift();
			if (!mint) {
				return refuse(`Unplanned ${owner} token exchange`);
			}
			if (mint.status === 503) {
				return reply({ error: "Owned token mint refused" }, 503);
			}
			if (!mint.holdBody) {
				return reply({ token: mint.token });
			}
			call.status = 200;
			const stream = new NativeReadableStream<Uint8Array>({
				start(controller) {
					// Headers and this partial JSON cross real HTTP before the remaining
					// signed token bytes are released. The production json() stays pending.
					controller.enqueue(new TextEncoder().encode('{"token":'));
					holds.set(call.id, () => {
						if (!holds.delete(call.id)) {
							throw new Error("Token body released twice");
						}
						controller.enqueue(
							new TextEncoder().encode(`${JSON.stringify(mint.token)}}`)
						);
						controller.close();
						call.bodyComplete = true;
						notifyChange();
					});
					notifyChange();
				},
				cancel() {
					holds.delete(call.id);
					call.bodyCancelled = true;
					notifyChange();
				},
			});
			return new NativeResponse(stream, {
				headers: {
					"content-type": "application/json",
					"x-jwt-owner-call": String(call.id),
				},
			});
		} finally {
			activeHandlers -= 1;
			notifyChange();
		}
	},
});

// Install finite egress admission before importing auth's boot consumer. These
// are its actual configured URLs, including each producer's slash convention.
const { BACKEND_URL } = await import("@/lib/app-urls.ts");
const expectedUrls = new Map([
	[`${BACKEND_URL}/api/auth/get-session`, "/api/auth/get-session"],
	[`${BACKEND_URL.replace(/\/$/, "")}/api/auth/token`, "/api/auth/token"],
]);
function observedCallId(response: Response) {
	const parsed = z.coerce
		.number()
		.int()
		.positive()
		.safeParse(response.headers.get("x-jwt-owner-call"));
	const call = parsed.success
		? calls.find((candidate) => candidate.id === parsed.data)
		: undefined;
	if (!call || call.status !== response.status) {
		unexpected.push(
			`Unowned native response acknowledgment ${response.headers.get("x-jwt-owner-call")}`
		);
		throw new Error("Unowned JWT proof response acknowledgment");
	}
	return call.id;
}

NativeResponse.prototype.json = function (this: Response) {
	const id = observedCallId(this);
	const observation = (async () => {
		const body: unknown = await nativeResponseJson.call(this);
		bodyReads.push({ id, status: this.status, body });
		return body;
	})();
	decoding.set(observation, id);
	const finished = () => {
		decoding.delete(observation);
		awaitingDecoder.delete(id);
		notifyChange();
	};
	void observation.then(finished, (error: unknown) => {
		transportErrors.push(`Native JWT body ${id}: ${String(error)}`);
		finished();
	});
	notifyChange();
	return observation;
};
globalThis.fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new NativeRequest(input, init);
		const path = expectedUrls.get(request.url);
		if (!path) {
			unexpected.push(`Unowned fetch ${request.method} ${request.url}`);
			throw new Error("Refused unowned JWT proof destination");
		}
		const forwarded = new NativeRequest(`${server.url.origin}${path}`, request);
		const exchange = nativeFetch(forwarded);
		exchanges.add(exchange);
		try {
			const response = await exchange;
			const id = observedCallId(response);
			if (response.ok) {
				awaitingDecoder.add(id);
			}
			return response;
		} catch (error) {
			transportErrors.push(`Native JWT exchange: ${String(error)}`);
			throw error;
		} finally {
			exchanges.delete(exchange);
			notifyChange();
		}
	},
	{
		preconnect: (...args: Parameters<typeof nativeFetch.preconnect>) => {
			unexpected.push(`Undeclared preconnect ${String(args[0])}`);
			throw new Error("JWT fixture declares no preconnect");
		},
	}
);
const {
	TOKEN_KEY,
	addAccount,
	getActiveToken,
	switchAccount,
	signOutAccount,
	listAccounts,
	getActiveUserId,
	vaultHydrated,
} = await import("@/lib/auth-client.ts");
await vaultHydrated;
const { clearRealtimeJwt, getRealtimeJwt, getRealtimeUserId } = await import(
	"./jwt.ts"
);

async function settleTransport() {
	while (exchanges.size || decoding.size || awaitingDecoder.size) {
		const pending = [...exchanges, ...decoding.keys()];
		if (pending.length) {
			await Promise.allSettled(pending);
		} else {
			await waitForChange(
				"A returned successful JWT/profile body was never decoded"
			);
		}
	}
}
function assertVault(expected: Owner[], active: Owner | null) {
	expect(listAccounts()).toEqual(expected.map((owner) => accounts[owner]));
	expect(getActiveUserId()).toBe(
		active === null ? null : accounts[active].userId
	);
	expect(getActiveToken()).toBe(
		active === null ? null : accounts[active].token
	);
	// The vault is never mirrored into localStorage in plaintext.
	expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
	expect(localStorage.getItem("ryu_waitlist_approved")).toBeNull();
	assertProtectedStorage();
}
beforeEach(async () => {
	await settleTransport();
	expect(holds.size).toBe(0);
	expect(consumerPromises.size).toBe(0);
	clearRealtimeJwt();
	mintPlans.clear();
	// The vault lives in memory (and the sealed native slot), not localStorage:
	// start each case from an empty vault through its own API.
	for (const account of listAccounts()) {
		await signOutAccount(account.userId);
	}
	for (const key of authKeys) {
		localStorage.removeItem(key);
	}
	localStorage.setItem("jwt-owner-proof:unrelated", "conserved");
	localStorage.setItem("ryu:timezone", "Asia/Tokyo");
	localStorage.setItem("ryu:node-auto-select", "true");
	localStorage.setItem(
		"ryu:node-dismissed-cloud",
		'["https://unrelated-node.example.test"]'
	);
	protectedStorage = storageEntries().filter(([key]) => !authKeys.has(key));
	caseStart = calls.length;
	localStorage.setItem("ryu_waitlist_approved", "true");
	expect(await addAccount(accounts.a.token)).toEqual(accounts.a);
	expect(await addAccount(accounts.b.token)).toEqual(accounts.b);
	await switchAccount(accounts.a.userId);
	assertVault(["a", "b"], "a");
	expect(
		bodyReads.filter((read) =>
			calls
				.slice(caseStart)
				.some(
					(call) => call.id === read.id && call.path === "/api/auth/get-session"
				)
		)
	).toHaveLength(2);
});
afterEach(async () => {
	try {
		for (const release of [...holds.values()]) {
			release();
		}
		await Promise.allSettled([...consumerPromises]);
		await settleTransport();
		await until(
			() => activeHandlers === 0,
			"Native token/profile handler outlived case teardown"
		);
		expect(holds.size).toBe(0);
		expect(consumerPromises.size).toBe(0);
		expect(waiters.size).toBe(0);
		expect(unexpected).toEqual([]);
		expect(transportErrors).toEqual([]);
		expect(
			bodyReads.every((read) => calls.some((call) => call.id === read.id))
		).toBe(true);
		assertProtectedStorage();
		clearRealtimeJwt();
	} finally {
		if (artifactDirectory) {
			await mkdir(artifactDirectory, { recursive: true });
			await writeFile(
				join(artifactDirectory, `case-${++diagnosticCase}.json`),
				JSON.stringify(
					{
						calls: calls.slice(caseStart),
						bodyReads,
						unexpected,
						transportErrors,
						holds: [...holds.keys()],
						activeHandlers,
						consumers: consumerPromises.size,
						exchanges: exchanges.size,
						decoding: [...decoding.values()],
						awaitingDecoder: [...awaitingDecoder],
						vault: listAccounts(),
						activeUserId: getActiveUserId(),
						storage: storageEntries(),
					},
					null,
					2
				)
			);
		}
	}
});
afterAll(async () => {
	try {
		for (const release of [...holds.values()]) {
			release();
		}
		await Promise.allSettled([...consumerPromises]);
		await settleTransport();
	} finally {
		await server.stop(true);
		clearRealtimeJwt();
		NativeResponse.prototype.json = nativeResponseJson;
		globalThis.fetch = nativeFetch;
		localStorage.clear();
		for (const [key, value] of originalStorage) {
			localStorage.setItem(key, value);
		}
		if (registeredAbortController) {
			Object.defineProperty(
				globalThis,
				"AbortController",
				registeredAbortController
			);
		} else {
			Reflect.deleteProperty(globalThis, "AbortController");
		}
		if (registeredAbortSignal) {
			Object.defineProperty(globalThis, "AbortSignal", registeredAbortSignal);
		} else {
			Reflect.deleteProperty(globalThis, "AbortSignal");
		}
		if (ownsDom) {
			await GlobalRegistrator.unregister();
		}
	}
});

test("same-owner JWT and subject consumers deduplicate one real held body and reuse the acknowledged identity", async () => {
	const mint = plan("a", "dedup-a", true);
	const first = observe(getRealtimeJwt());
	const subject = observe(getRealtimeUserId());
	const second = observe(getRealtimeJwt());
	const call = await heldToken("a");
	expect(tokenCalls()).toHaveLength(1);
	consumeHeldBody(call);
	expect(await Promise.all([first, subject, second])).toEqual([
		mint.token,
		accounts.a.userId,
		mint.token,
	]);
	await acknowledgedToken("a", mint.token);
	expect(await getRealtimeUserId()).toBe(accounts.a.userId);
	expect(await getRealtimeJwt()).toBe(mint.token);
	expect(tokenCalls()).toHaveLength(1);
	assertVault(["a", "b"], "a");
});

test("acknowledged account B gets its own native token while A body is held and late A returns no identity", async () => {
	plan("a", "retired-a", true);
	const oldToken = observe(getRealtimeJwt());
	const oldSubject = observe(getRealtimeUserId());
	const oldCall = await heldToken("a");
	await switchAccount(accounts.b.userId);
	assertVault(["a", "b"], "b");
	const current = plan("b", "current-b");
	const currentToken = observe(getRealtimeJwt());
	const currentSubject = observe(getRealtimeUserId());
	await acknowledgedToken("b", current.token);
	expect(await Promise.all([currentToken, currentSubject])).toEqual([
		current.token,
		accounts.b.userId,
	]);
	expect(holds.has(oldCall.id)).toBe(true);
	expect(tokenCalls("a")).toHaveLength(1);
	expect(tokenCalls("b")).toHaveLength(1);
	consumeHeldBody(oldCall);
	expect(await Promise.all([oldToken, oldSubject])).toEqual([null, null]);
	expect(await getRealtimeJwt()).toBe(current.token);
	expect(await getRealtimeUserId()).toBe(accounts.b.userId);
	expect(tokenCalls()).toHaveLength(2);
	assertVault(["a", "b"], "b");
});

test("an admitted native HTTP503 mint stays anonymous through its backoff and a genuine retry after it acknowledges the same owner", async () => {
	plan("a", "refused-a", false, 503);
	expect(await observe(getRealtimeJwt())).toBeNull();
	expect(tokenCalls()).toHaveLength(1);
	expect(tokenCalls()[0]).toMatchObject({
		owner: "a",
		status: 503,
		bodyComplete: true,
		bodyCancelled: false,
	});
	const recovered = plan("a", "retry-a");
	// The refusal is remembered: an immediate retry stays anonymous and does
	// not reach the token endpoint again.
	expect(await observe(getRealtimeJwt())).toBeNull();
	expect(tokenCalls()).toHaveLength(1);
	// Once the failure backoff has elapsed, a genuine retry mints again.
	setSystemTime(new Date(Date.now() + 31_000));
	try {
		expect(await observe(getRealtimeJwt())).toBe(recovered.token);
		await acknowledgedToken("a", recovered.token);
		expect(await getRealtimeUserId()).toBe(accounts.a.userId);
		expect(tokenCalls()).toHaveLength(2);
	} finally {
		setSystemTime();
	}
	assertVault(["a", "b"], "a");
});

test("actual sole-account signout conserves unrelated records and retires a held token and subject", async () => {
	await signOutAccount(accounts.b.userId);
	assertVault(["a"], "a");
	plan("a", "signed-out-a", true);
	const oldToken = observe(getRealtimeJwt());
	const oldSubject = observe(getRealtimeUserId());
	const call = await heldToken("a");
	await signOutAccount(accounts.a.userId);
	assertVault([], null);
	expect(localStorage.getItem("ryu_accounts")).toBeNull();
	expect(localStorage.getItem("ryu_active_user_id")).toBeNull();
	expect(await getRealtimeJwt()).toBeNull();
	expect(await getRealtimeUserId()).toBeNull();
	expect(tokenCalls()).toHaveLength(1);
	consumeHeldBody(call);
	expect(await Promise.all([oldToken, oldSubject])).toEqual([null, null]);
	expect(await getRealtimeJwt()).toBeNull();
	expect(await getRealtimeUserId()).toBeNull();
	expect(tokenCalls()).toHaveLength(1);
	assertVault([], null);
});

test("observed A to B to A vault transitions require a fresh returned-A mint and reject the original generation", async () => {
	plan("a", "original-a-generation", true);
	const originalToken = observe(getRealtimeJwt());
	const originalSubject = observe(getRealtimeUserId());
	const originalCall = await heldToken("a");
	await switchAccount(accounts.b.userId);
	assertVault(["a", "b"], "b");
	const intermediate = plan("b", "intermediate-b-generation");
	const intermediateToken = observe(getRealtimeJwt());
	const intermediateSubject = observe(getRealtimeUserId());
	await acknowledgedToken("b", intermediate.token);
	expect(await Promise.all([intermediateToken, intermediateSubject])).toEqual([
		intermediate.token,
		accounts.b.userId,
	]);
	await switchAccount(accounts.a.userId);
	assertVault(["a", "b"], "a");
	const returned = plan("a", "returned-a-generation");
	const returnedToken = observe(getRealtimeJwt());
	const returnedSubject = observe(getRealtimeUserId());
	await acknowledgedToken("a", returned.token);
	expect(await Promise.all([returnedToken, returnedSubject])).toEqual([
		returned.token,
		accounts.a.userId,
	]);
	expect(tokenCalls("a")).toHaveLength(2);
	expect(tokenCalls("b")).toHaveLength(1);
	expect(holds.has(originalCall.id)).toBe(true);
	consumeHeldBody(originalCall);
	expect(await Promise.all([originalToken, originalSubject])).toEqual([
		null,
		null,
	]);
	expect(await getRealtimeJwt()).toBe(returned.token);
	expect(await getRealtimeUserId()).toBe(accounts.a.userId);
	expect(tokenCalls()).toHaveLength(3);
	assertVault(["a", "b"], "a");
});
