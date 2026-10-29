import { afterEach, describe, expect, it } from "bun:test";
import { ApiError } from "./client.ts";
import {
	fetchMfaEnrollmentAccess,
	isMfaEnrollmentRequiredError,
	MFA_ENROLLMENT_REQUIRED_CODE,
	mfaEnrollmentSetupUrl,
} from "./mfa-enrollment.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

const target = {
	token: "better-auth-token",
	url: "https://account.example.test/",
};

function respondWith(response: () => Response): void {
	globalThis.fetch = createFetchFixture(() => Promise.resolve(response()));
}

describe("fetchMfaEnrollmentAccess", () => {
	it("reads the status endpoint with the session bearer", async () => {
		let request: Request | undefined;
		globalThis.fetch = createFetchFixture(async (input, init) => {
			request = new Request(input, init);
			return Response.json({
				code: MFA_ENROLLMENT_REQUIRED_CODE,
				enforced: true,
				passkeyCount: 0,
				required: true,
				twoFactorEnabled: false,
			});
		});

		expect(await fetchMfaEnrollmentAccess(target)).toBe("required");
		expect(request?.url).toBe(
			"https://account.example.test/api/auth/mfa-enrollment/status"
		);
		expect(request?.headers.get("authorization")).toBe(
			"Bearer better-auth-token"
		);
		expect(request?.credentials).toBe("include");
	});

	it("is clear for an enrolled, exempt or unenforced account", async () => {
		respondWith(() =>
			Response.json({
				code: null,
				enforced: true,
				passkeyCount: 1,
				required: false,
				twoFactorEnabled: false,
			})
		);
		expect(await fetchMfaEnrollmentAccess(target)).toBe("clear");
	});

	it("is exempt, not clear, while the mandate does not apply to the account", async () => {
		respondWith(() =>
			Response.json({
				code: null,
				enforced: false,
				passkeyCount: 0,
				required: false,
				twoFactorEnabled: false,
			})
		);
		expect(await fetchMfaEnrollmentAccess(target)).toBe("exempt");
	});

	it("is clear against a control plane without the endpoint", async () => {
		respondWith(() => new Response(null, { status: 404 }));
		expect(await fetchMfaEnrollmentAccess(target)).toBe("clear");
	});

	it("is unknown when the status cannot be read", async () => {
		respondWith(() => new Response(null, { status: 503 }));
		expect(await fetchMfaEnrollmentAccess(target)).toBe("unknown");

		respondWith(() => new Response(null, { status: 401 }));
		expect(await fetchMfaEnrollmentAccess(target)).toBe("unknown");

		respondWith(() => Response.json({ required: "yes" }));
		expect(await fetchMfaEnrollmentAccess(target)).toBe("unknown");

		globalThis.fetch = createFetchFixture(() =>
			Promise.reject(new Error("offline"))
		);
		expect(await fetchMfaEnrollmentAccess(target)).toBe("unknown");
	});

	it("sends no bearer for a cookie session", async () => {
		let request: Request | undefined;
		globalThis.fetch = createFetchFixture(async (input, init) => {
			request = new Request(input, init);
			return Response.json({ required: false });
		});
		expect(
			await fetchMfaEnrollmentAccess({ token: "  ", url: target.url })
		).toBe("clear");
		expect(request?.headers.get("authorization")).toBeNull();
	});
});

describe("mfaEnrollmentSetupUrl", () => {
	it("points at the website's setup page", () => {
		expect(mfaEnrollmentSetupUrl("https://ryu.example/")).toBe(
			"https://ryu.example/settings/setup-2fa"
		);
	});
});

describe("isMfaEnrollmentRequiredError", () => {
	it("recognizes the control plane's enrollment refusal", () => {
		expect(
			isMfaEnrollmentRequiredError(
				new ApiError(
					"/api/sessions",
					403,
					"Set up a passkey",
					MFA_ENROLLMENT_REQUIRED_CODE
				)
			)
		).toBe(true);
		expect(
			isMfaEnrollmentRequiredError(new ApiError("/api/sessions", 403))
		).toBe(false);
		expect(isMfaEnrollmentRequiredError(new Error("failed"))).toBe(false);
		expect(isMfaEnrollmentRequiredError(null)).toBe(false);
	});
});
