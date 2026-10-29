import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fetchSession, runWhoami } from "./auth.ts";
import { legacyRawAuthProfileObservationSchema } from "./session-response-contracts.ts";

type ObservedSessionRequest = readonly [
	URL["pathname"],
	ReturnType<Headers["get"]>,
];

async function withSessionBody<Value>(
	body: string,
	read: (
		baseUrl: string,
		requests: readonly ObservedSessionRequest[]
	) => Promise<Value>
): Promise<Value> {
	const requests: ObservedSessionRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			requests.push([
				new URL(request.url).pathname,
				request.headers.get("Authorization"),
			]);
			return new Response(body, {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	try {
		return await read(server.url.origin, requests);
	} finally {
		server.stop(true);
	}
}

describe("native get-session wire and legacy profile observations", () => {
	test("complete publisher keeps serialized dates and exact email", async () => {
		const date = "2026-10-07T00:00:00.000Z";
		const payload = {
			session: {
				id: "session",
				userId: "user",
				token: "token",
				expiresAt: date,
				createdAt: date,
				updatedAt: date,
				ipAddress: null,
				userAgent: null,
				impersonatedBy: null,
				activeOrganizationId: null,
				activeTeamId: null,
			},
			user: {
				id: "user",
				name: "Ada",
				email: "Ada@EXAMPLE.test",
				emailVerified: true,
				createdAt: date,
				updatedAt: date,
				image: null,
				twoFactorEnabled: false,
				avatarId: null,
				resendContactId: null,
				emailVerifiedAt: null,
				lastEmailSentAt: null,
				dailyEmailCount: null,
				lastEmailResetDate: null,
				referralCode: null,
				referredBy: null,
				referralCount: null,
				profileVisibility: "public",
				username: null,
				displayUsername: null,
				isAnonymous: false,
				role: "user",
				banned: false,
				banReason: null,
				banExpires: null,
			},
		};
		await withSessionBody(JSON.stringify(payload), async (base, requests) => {
			const user = await fetchSession("token", base);
			expect(requests).toHaveLength(1);
			for (const [pathname, authorization] of requests) {
				expect(pathname).toBe("/api/auth/get-session");
				expect(authorization).toBe("Bearer token");
			}
			expect(user).toEqual(payload.user);
			expect(user?.email).toBe("Ada@EXAMPLE.test");
			expect(user?.createdAt).toBe(date);
		});
	});

	test("legacy empty and partial objects remain live profiles", async () => {
		await withSessionBody('{"user":{}}', async (base, requests) => {
			expect(await fetchSession("token", base)).toEqual({});
			expect(requests).toHaveLength(1);
			for (const [pathname, authorization] of requests) {
				expect(pathname).toBe("/api/auth/get-session");
				expect(authorization).toBe("Bearer token");
			}
		});
		await withSessionBody(
			'{"user":{"name":["Ada"],"email":23,"future":{"kept":true}}}',
			async (base, requests) => {
				expect(await fetchSession("token", base)).toEqual({
					name: ["Ada"],
					email: 23,
					future: { kept: true },
				});
				expect(requests).toHaveLength(1);
				for (const [pathname, authorization] of requests) {
					expect(pathname).toBe("/api/auth/get-session");
					expect(authorization).toBe("Bearer token");
				}
			}
		);
	});

	test("legacy observation returns the same raw profile, including overflow and deep metadata", () => {
		const profile = JSON.parse(
			'{"name":1e1000,"email":-1e1000,"__proto__":{"own":true},"future":' +
				"[".repeat(15_000) +
				"0" +
				"]".repeat(15_000) +
				"}"
		);
		const observed = legacyRawAuthProfileObservationSchema.parse(profile);
		expect(observed).toBe(profile);
		expect(observed.future).toBe(profile.future);
		expect(observed.name).toBe(Number.POSITIVE_INFINITY);
		expect(observed.email).toBe(Number.NEGATIVE_INFINITY);
		expect(Object.hasOwn(observed, "__proto__")).toBe(true);
	});

	test.each([
		'{"user":[]}',
		'{"user":"Ada"}',
		'{"user":true}',
		'{"user":23}',
	])("malformed live profile uses the existing unavailable result: %s", async (body) => {
		await withSessionBody(body, async (base, requests) => {
			expect(await fetchSession("token", base)).toBeNull();
			expect(requests).toHaveLength(1);
			for (const [pathname, authorization] of requests) {
				expect(pathname).toBe("/api/auth/get-session");
				expect(authorization).toBe("Bearer token");
			}
		});
	});

	test("malformed live profile preserves cached whoami fallback", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ryu-mcp-session-"));
		const authPath = join(directory, "auth.json");
		const previousAuthPath = process.env.RYU_MCP_AUTH_FILE;
		const originalWrite = process.stdout.write;
		let output = "";
		try {
			process.env.RYU_MCP_AUTH_FILE = authPath;
			await withSessionBody('{"user":[]}', async (base, requests) => {
				writeFileSync(
					authPath,
					JSON.stringify({
						token: "token",
						backendUrl: base,
						name: "Cached Ada",
					})
				);
				process.stdout.write = (chunk) => {
					output += String(chunk);
					return true;
				};
				await runWhoami();
				expect(requests).toHaveLength(1);
				for (const [pathname, authorization] of requests) {
					expect(pathname).toBe("/api/auth/get-session");
					expect(authorization).toBe("Bearer token");
				}
				expect(output).toBe(
					"Signed in (Cached Ada) - control plane unreachable or token expired.\n"
				);
			});
		} finally {
			process.stdout.write = originalWrite;
			if (previousAuthPath === undefined) {
				delete process.env.RYU_MCP_AUTH_FILE;
			} else {
				process.env.RYU_MCP_AUTH_FILE = previousAuthPath;
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("fixed root diagnostics do not invoke ambient formatting", () => {
		const previousCustomError = z.config().customError;
		try {
			z.config({
				customError: () => {
					throw new Error("unexpected ambient formatter");
				},
			});
			expect(legacyRawAuthProfileObservationSchema.safeParse([]).success).toBe(
				false
			);
			expect(
				legacyRawAuthProfileObservationSchema.safeParse({
					name: Number.POSITIVE_INFINITY,
				}).success
			).toBe(true);
		} finally {
			z.config({ customError: previousCustomError });
		}
	});
});
