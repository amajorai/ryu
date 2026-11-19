import { setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { EmailCooldown } from "@ryu/db/models/email-cooldown.model";
import { ownedReplicaSetUrl } from "@ryu/db/test-support/owned-replica-set";
import { serializeSignedCookie } from "better-call";

/**
 * The shipping `auth` instance on a real replica set, for the email
 * enumeration tests (email-cooldown-plugin.test.ts, email-enumeration-trace
 * .test.ts). Only the mail provider is a fixture. Every Mongo command the
 * process sends can be recorded (`startTrace`), and so can every delivery,
 * so a test can compare what a request did before it answered.
 *
 * test-exempt: a fixture, exercised by the tests that import it.
 */

const PROVIDER_KEY = "email-enumeration-provider-key";
export const delivered: string[] = [];
let trace: string[] | null = null;

const provider = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const payload = (await request.json()) as { to?: string };
		delivered.push((payload.to ?? "").toLowerCase());
		trace?.push("mail");
		return Response.json({ emailId: randomUUID() });
	},
});
const databaseUrl = await ownedReplicaSetUrl(
	`ryu_auth_email_enumeration_${randomUUID().replaceAll("-", "")}`
);
const monitoredUrl = new URL(databaseUrl.href);
monitoredUrl.searchParams.set("monitorCommands", "true");
Object.assign(process.env, {
	BETTER_AUTH_SECRET: "email-enumeration-fixture-".repeat(2),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: monitoredUrl.href,
	NODE_ENV: "test",
	POLAR_ACCESS_TOKEN: "local-test",
	POLAR_BILLING_AUTHORITY: "local",
	POLAR_SERVER: "sandbox",
	POLAR_SUCCESS_URL: "http://localhost:3001/success",
	RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
	RYU_DIR: "/tmp/ryu-dev-headless",
	RYU_KEYCHAIN: "off",
	RYU_PROFILE: "dev",
	// With a provider key `sendEmail` takes the production path: the cooldown
	// check, the provider call and the stats update.
	USESEND_API_KEY: PROVIDER_KEY,
	USESEND_URL: provider.url.origin,
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	(input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname !== "127.0.0.1") {
			return Promise.reject(new Error(`Unexpected egress to ${url.host}`));
		}
		return nativeFetch(input, init);
	},
	{ preconnect: nativeFetch.preconnect }
);

export const { auth } = await import("../index.ts");
export const { holdDetachedTasks, settleDetachedTasks } = await import(
	"./detached-delivery.ts"
);
const mongoose = EmailCooldown.base;
export const independent = await mongoose
	.createConnection(databaseUrl.href, { serverSelectionTimeoutMS: 10_000 })
	.asPromise();

/** Connection upkeep, not request work. */
const UNTRACED = new Set([
	"createIndexes",
	"endSessions",
	"hello",
	"isMaster",
	"ismaster",
	"listIndexes",
	"ping",
]);
mongoose.connection.getClient().on("commandStarted", (event) => {
	if (!trace || UNTRACED.has(event.commandName)) {
		return;
	}
	const target = event.command[event.commandName];
	trace.push(
		`${event.commandName} ${typeof target === "string" ? target : ""}`.trim()
	);
});

/** Record every Mongo command and delivery until `stop` is called. */
export function startTrace(): { stop: () => string[] } {
	const recorded: string[] = [];
	trace = recorded;
	return {
		stop: () => {
			if (trace === recorded) {
				trace = null;
			}
			return recorded;
		},
	};
}

export type Account =
	| "registered"
	| "banned"
	| "unverified"
	| "twoFactor"
	| "unregistered";
export type SeededAccount = Exclude<Account, "unregistered">;
const SEEDED: readonly SeededAccount[] = [
	"registered",
	"banned",
	"unverified",
	"twoFactor",
];
const ACCOUNT_FIELDS: Record<SeededAccount, Record<string, unknown>> = {
	banned: { banned: true, banReason: "spam" },
	registered: {},
	twoFactor: { twoFactorEnabled: true },
	unverified: { emailVerified: false },
};

let clock = Date.now();
let requestNumber = 0;

export function freezeClock(): void {
	setSystemTime(new Date(clock));
}

export function pastTheCooldown(): void {
	clock += 61_000;
	setSystemTime(new Date(clock));
}

export function addressFor(endpoint: string, account: Account): string {
	return `${account.toLowerCase()}.${endpoint}@enumeration.example.test`;
}

/** A user row for every seeded kind of account, `extra` applied to all. */
export async function seedAccounts(
	endpoint: string,
	extra: Record<string, unknown> = {}
): Promise<Record<Account, string>> {
	const now = new Date();
	const ids = Object.fromEntries(
		SEEDED.map((account) => [account, new mongoose.Types.ObjectId()])
	) as Record<SeededAccount, InstanceType<typeof mongoose.Types.ObjectId>>;
	await independent.collection("user").insertMany(
		SEEDED.map((account) => ({
			_id: ids[account],
			banExpires: null,
			banReason: null,
			banned: false,
			createdAt: now,
			email: addressFor(endpoint, account),
			emailVerified: true,
			name: account,
			role: "user",
			twoFactorEnabled: false,
			updatedAt: now,
			...ACCOUNT_FIELDS[account],
			...extra,
		}))
	);
	return {
		banned: String(ids.banned),
		registered: String(ids.registered),
		twoFactor: String(ids.twoFactor),
		unregistered: String(new mongoose.Types.ObjectId()),
		unverified: String(ids.unverified),
	};
}

export interface Answer {
	body: string;
	cookies: string[];
	headers: [string, string][];
	status: number;
}

/**
 * One request as a browser would send it. Each comes from its own address,
 * so Better Auth's per-IP limiter never answers in place of the cooldown.
 */
export async function call(
	path: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<Answer> {
	requestNumber += 1;
	const response = await auth.handler(
		new Request(`http://localhost:3000/api/auth${path}`, {
			body: JSON.stringify(body),
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				"x-forwarded-for": `198.51.100.${requestNumber % 250}`,
				...headers,
			},
			method: "POST",
		})
	);
	const responseHeaders: [string, string][] = [];
	response.headers.forEach((value, name) => {
		if (name !== "set-cookie") {
			responseHeaders.push([name, value]);
		}
	});
	return {
		body: await response.text(),
		cookies: response.headers.getSetCookie(),
		headers: responseHeaders.sort(([a], [b]) => a.localeCompare(b)),
		status: response.status,
	};
}

/** The signed challenge cookie a password sign-in leaves for `userId`. */
export async function twoFactorCookie(userId: string): Promise<string> {
	const context = await auth.$context;
	const identifier = `two-factor-${randomUUID()}`;
	await context.internalAdapter.createVerificationValue({
		expiresAt: new Date(clock + 10 * 60_000),
		identifier,
		value: userId,
	});
	const cookie = await serializeSignedCookie(
		context.createAuthCookie("two_factor").name,
		identifier,
		context.secret
	);
	return cookie.split(";")[0] ?? "";
}

/** Mails delivered to `address`, once every detached send has finished. */
export async function mailsTo(address: string): Promise<number> {
	await settleDetachedTasks();
	return delivered.filter((to) => to === address).length;
}

export async function closeFixture(): Promise<void> {
	await settleDetachedTasks();
	setSystemTime();
	globalThis.fetch = nativeFetch;
	provider.stop(true);
	await independent.dropDatabase();
	await independent.close();
}
