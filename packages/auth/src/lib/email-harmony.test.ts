import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { validateEmail } from "better-auth-harmony/email";
import { ryuEmailHarmony } from "./email-harmony.ts";

describe("Ryu email Harmony integration", () => {
	it("registers the internal normalized email field", () => {
		const field = ryuEmailHarmony.schema?.user?.fields?.normalizedEmail;

		expect(field).toMatchObject({
			input: false,
			required: false,
			returned: false,
			type: "string",
			unique: true,
		});
	});

	it("recognizes normalized email sign-in routes without rewriting signup", () => {
		const hooks = ryuEmailHarmony.hooks?.before ?? [];
		const normalizedSignInHook = hooks[1];

		if (!normalizedSignInHook) {
			throw new Error("Missing normalized email sign-in hook");
		}
		const matchesRoute = (path: string) => {
			// SAFETY: This Harmony matcher reads only the endpoint path. These fixtures exercise its sign-in/sign-up discrimination; handler behavior is tested through real Better Auth requests below.
			const route = { path } as Parameters<
				typeof normalizedSignInHook.matcher
			>[0];
			return normalizedSignInHook.matcher(route);
		};
		expect(matchesRoute("/sign-in/email")).toBe(true);
		expect(matchesRoute("/sign-up/email")).toBe(false);
	});

	it("rejects disposable email addresses through Harmony's validator", () => {
		expect(validateEmail("person@mailinator.com")).toBe(false);
		expect(validateEmail("person@example.org")).toBe(true);
	});
});

it("conceals normalized signup collisions without leaking the registered alias", async () => {
	const database = new Database(":memory:");
	const notifications: string[] = [];
	const options = {
		baseURL: "http://localhost:3000",
		secret: "email-harmony-test-secret-at-least-32-characters",
		database,
		rateLimit: { enabled: false },
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			onExistingUserSignUp: async ({ user }) => {
				notifications.push(user.email);
			},
		},
		emailVerification: { sendVerificationEmail: async () => undefined },
		plugins: [ryuEmailHarmony],
	} satisfies BetterAuthOptions;
	await (await getMigrations(options)).runMigrations();
	const auth = betterAuth(options);
	const signup = (email: string) =>
		auth.handler(
			new Request("http://localhost:3000/api/auth/sign-up/email", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
				},
				body: JSON.stringify({
					name: "Person",
					email,
					password: "strong-password-1234",
				}),
			})
		);
	for (const email of [
		"victim+private@gmail.com",
		"victim+private@gmail.com",
		"victim+probe@gmail.com",
		"unused+probe@gmail.com",
	]) {
		const response = await signup(email);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.token).toBeNull();
		expect(body.user.email).toBe(email);
		expect(body.user.normalizedEmail).toBeUndefined();
	}
	expect(database.query("SELECT COUNT(*) AS count FROM user").get()).toEqual({
		count: 2,
	});
	expect(() =>
		database.run(
			"INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, normalizedEmail) VALUES ('collision', 'Person', 'victim+other@gmail.com', 0, 0, 0, 'victim@gmail.com')"
		)
	).toThrow();
	expect(notifications).toEqual([
		"victim+private@gmail.com",
		"victim+private@gmail.com",
	]);
	const concurrent = await Promise.all([
		signup("concurrent+one@gmail.com"),
		signup("c.o.n.c.u.r.r.e.n.t+two@googlemail.com"),
	]);
	for (const response of concurrent) {
		expect(response.status).toBe(200);
	}
	expect(database.query("SELECT COUNT(*) AS count FROM user").get()).toEqual({
		count: 3,
	});
	database.close();
});
