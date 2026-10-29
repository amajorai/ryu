import { afterAll, describe, expect, it, mock } from "bun:test";

/**
 * Email-and-password sign-in through the real `auth` instance must not tell an
 * unauthenticated caller which addresses hold an account without a password
 * (Google-only, or magic-link-only with no account rows). Each of them is
 * answered exactly like an address nobody registered. Only the Mongo driver is
 * stubbed: it knows the two passwordless users below and nobody else.
 */
Object.assign(process.env, {
	BETTER_AUTH_SECRET: "sign-in-enumeration-".repeat(3),
	BETTER_AUTH_URL: "http://localhost:3000",
	DATABASE_URL: "mongodb://127.0.0.1:1/unused-sign-in-enumeration-fixture",
	NODE_ENV: "test",
	POLAR_ACCESS_TOKEN: "local-test",
	POLAR_BILLING_AUTHORITY: "local",
	POLAR_SERVER: "sandbox",
	POLAR_SUCCESS_URL: "http://localhost:3001/success",
	RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
	RYU_DIR: "/tmp/ryu-dev-headless",
	RYU_KEYCHAIN: "off",
	RYU_PROFILE: "dev",
});

const GOOGLE_ONLY_EMAIL = "google-only@example.com";
const MAGIC_LINK_ONLY_EMAIL = "magic-link-only@example.com";
const UNKNOWN_EMAIL = "nobody-registered@example.com";
const GOOGLE_ONLY_ID = "64b0000000000000000000a1";
const MAGIC_LINK_ONLY_ID = "64b0000000000000000000a2";
const FIXTURE_TIME = new Date("2026-01-01T00:00:00.000Z");

function storedUser(id: string, email: string) {
	return {
		_id: id,
		createdAt: FIXTURE_TIME,
		email,
		emailVerified: true,
		name: "Passwordless Person",
		updatedAt: FIXTURE_TIME,
	};
}

/** `user` rows with the `account` join Better Auth asks for on sign-in. */
const passwordlessUsers = [
	{
		...storedUser(GOOGLE_ONLY_ID, GOOGLE_ONLY_EMAIL),
		account: [
			{
				_id: "64b0000000000000000000b1",
				accountId: "google-subject-1",
				createdAt: FIXTURE_TIME,
				providerId: "google",
				updatedAt: FIXTURE_TIME,
				userId: GOOGLE_ONLY_ID,
			},
		],
	},
	{ ...storedUser(MAGIC_LINK_ONLY_ID, MAGIC_LINK_ONLY_EMAIL), account: [] },
];

function cursor(rows: unknown[]) {
	const chain = {
		limit: () => chain,
		next: async () => rows[0] ?? null,
		project: () => chain,
		skip: () => chain,
		sort: () => chain,
		toArray: async () => rows,
		async *[Symbol.asyncIterator]() {
			yield* rows;
		},
	};
	return chain;
}

/** The stored users a `user` lookup names by address; nobody else exists. */
function usersMatching(query: unknown) {
	const filter = JSON.stringify(query);
	return passwordlessUsers.filter((user) => filter.includes(user.email));
}

function collection(name: string) {
	return new Proxy(
		{},
		{
			get: (_target, method) => {
				if (method === "find" || method === "aggregate") {
					return (query: unknown) =>
						cursor(name === "user" ? usersMatching(query) : []);
				}
				if (method === "insertOne") {
					return async () => ({ acknowledged: true, insertedId: "fixture" });
				}
				return async () => null;
			},
		}
	);
}
mock.module("@ryu/db", () => ({
	client: { collection },
	mongoClient: {},
}));

const { auth } = await import("./index.ts");

afterAll(() => {
	mock.restore();
});

async function signInWithPassword(email: string) {
	const response = await auth.handler(
		new Request("http://localhost:3000/api/auth/sign-in/email", {
			body: JSON.stringify({ email, password: "Any-guess-at-all-2026!" }),
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
			},
			method: "POST",
		})
	);
	return { body: await response.text(), status: response.status };
}

const GENERIC_FAILURE = { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 };

/** The status and Better Auth error code a sign-in reply carries. */
function outcome(reply: { body: string; status: number }) {
	const code: unknown = JSON.parse(reply.body).code;
	return { code, status: reply.status };
}

describe("email sign-in for an account without a password", () => {
	it("answers an unknown address with the generic invalid-credentials error", async () => {
		const unknown = await signInWithPassword(UNKNOWN_EMAIL);
		expect(outcome(unknown)).toEqual(GENERIC_FAILURE);
	});

	it("answers a Google-only account exactly like an unknown address", async () => {
		const passwordless = await signInWithPassword(GOOGLE_ONLY_EMAIL);
		expect(passwordless.body).not.toContain("NO_PASSWORD_ACCOUNT");
		expect(outcome(passwordless)).toEqual(GENERIC_FAILURE);
		expect(passwordless).toEqual(await signInWithPassword(UNKNOWN_EMAIL));
	});

	it("answers a magic-link-only account exactly like an unknown address", async () => {
		const passwordless = await signInWithPassword(MAGIC_LINK_ONLY_EMAIL);
		expect(passwordless.body).not.toContain("NO_PASSWORD_ACCOUNT");
		expect(outcome(passwordless)).toEqual(GENERIC_FAILURE);
		expect(passwordless).toEqual(await signInWithPassword(UNKNOWN_EMAIL));
	});
});
