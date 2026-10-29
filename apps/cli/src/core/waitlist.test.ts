import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WAITLIST_MANAGED_ONLY_FLAG } from "@ryuhq/protocol/feature-flags";
import { authBackendUrl } from "./authBackend.ts";
import {
	CLI_GATE_DEADLINES,
	CLI_GATE_POLL_MS,
	resolveCliGateAccess,
	resolveCliWaitlistAccess,
} from "./waitlist.ts";

const realFetch = globalThis.fetch;
// Core's /api/auth/status publisher always serializes all five fields.
function authStatus(token: string) {
	return {
		authenticated: true,
		pending: false,
		token,
		userCode: null,
		verificationUri: null,
	};
}

const originalAuthUrl = process.env.RYU_AUTH_URL;

beforeEach(() => {
	// These flows use a configured local account service. The unconfigured
	// loopback default is never sent account credentials (core/authBackend.ts).
	process.env.RYU_AUTH_URL = "http://localhost:3000";
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

describe("resolveCliWaitlistAccess", () => {
	it("checks every active node under the default server scope", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.endsWith("/api/auth/status")) {
					return Response.json(authStatus("cloud-token"));
				}
				if (request.url.endsWith("/api/feature-flags/public")) {
					return Response.json({
						features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: false },
					});
				}
				return Response.json({ status: "approved" });
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveCliWaitlistAccess({
				token: "core-token",
				url: "http://127.0.0.1:8980",
			})
		).toBe("approved");
		expect(requests).toHaveLength(3);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer core-token");
		expect(requests[1]?.url).toContain("/api/feature-flags/public");
		expect(requests[1]?.headers.get("authorization")).toBeNull();
		expect(requests[2]?.headers.get("authorization")).toBe(
			"Bearer cloud-token"
		);
	});

	it("bypasses an unlisted self-hosted node in managed-only server scope", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.endsWith("/api/auth/status")) {
					return Response.json(authStatus("cloud-token"));
				}
				if (request.url.endsWith("/api/feature-flags/public")) {
					return Response.json({
						features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: true },
					});
				}
				return Response.json({
					nodes: [{ url: "https://other.example.test" }],
				});
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveCliWaitlistAccess({
				token: null,
				url: "https://self-hosted.example.test",
			})
		).toBe("approved");
		expect(requests).toHaveLength(3);
		expect(requests[1]?.url).toContain("/api/feature-flags/public");
		expect(requests[2]?.url).toContain("/api/control-plane/nodes");
		expect(requests[1]?.headers.get("authorization")).toBeNull();
		expect(requests[2]?.headers.get("authorization")).toBe(
			"Bearer cloud-token"
		);
	});

	it("does not forward a node bearer when Core auth status is unavailable", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				requests.push(new Request(input, init));
				throw new Error("Core offline");
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveCliWaitlistAccess({
				token: "local-node-bearer",
				url: "http://127.0.0.1:2049",
			})
		).toBe("approved");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("/api/auth/status");
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer local-node-bearer"
		);
	});
});

const MFA_STATUS_PATH = "/api/auth/mfa-enrollment/status";
const NODE = { token: "core-token", url: "http://127.0.0.1:8980" };

/** A server that never answers; it gives up only when the caller aborts. */
function answerNever(signal: AbortSignal | null | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

/** A control plane that approves the waitlist and answers enrollment as given. */
function installControlPlane(options: {
	coreToken: string | null;
	enrollment: () => Response;
	/** A path whose server never answers until the request is aborted. */
	hangs?: string;
	managedOnly?: boolean;
	waitlist?: "approved" | "pending";
}): Request[] {
	const requests: Request[] = [];
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(request);
			const url = new URL(request.url);
			if (url.pathname === options.hangs) {
				return await answerNever(init?.signal);
			}
			if (url.pathname === "/api/auth/status") {
				return Response.json(
					options.coreToken
						? authStatus(options.coreToken)
						: { ...authStatus(""), authenticated: false, token: null }
				);
			}
			if (url.pathname === "/api/feature-flags/public") {
				return Response.json({
					features: {
						[WAITLIST_MANAGED_ONLY_FLAG.key]: options.managedOnly ?? false,
					},
				});
			}
			if (url.pathname === "/api/control-plane/nodes") {
				return Response.json({ nodes: [] });
			}
			if (url.pathname === MFA_STATUS_PATH) {
				return options.enrollment();
			}
			return Response.json({ status: options.waitlist ?? "approved" });
		},
		{ preconnect: realFetch.preconnect }
	);
	return requests;
}

function enrollmentRequests(requests: Request[]): Request[] {
	return requests.filter(
		(request) => new URL(request.url).pathname === MFA_STATUS_PATH
	);
}

describe("resolveCliGateAccess", () => {
	it("asks the control plane about enrollment with the account bearer once the waitlist approves", async () => {
		const requests = installControlPlane({
			coreToken: "cloud-token",
			enrollment: () => Response.json({ required: true }),
		});

		expect(await resolveCliGateAccess(NODE)).toBe("mfa_enrollment_required");
		const [enrollment] = enrollmentRequests(requests);
		expect(enrollmentRequests(requests)).toHaveLength(1);
		expect(new URL(enrollment?.url ?? "").origin).toBe(authBackendUrl());
		expect(enrollment?.headers.get("authorization")).toBe("Bearer cloud-token");
		// The enrollment read comes after the waitlist decision.
		expect(new URL(requests.at(-1)?.url ?? "").pathname).toBe(MFA_STATUS_PATH);
	});

	it("admits an enrolled account", async () => {
		installControlPlane({
			coreToken: "cloud-token",
			enrollment: () => Response.json({ required: false }),
		});

		expect(await resolveCliGateAccess(NODE)).toBe("approved");
	});

	it("never blocks when the enrollment status cannot be read", async () => {
		const requests = installControlPlane({
			coreToken: "cloud-token",
			enrollment: () => Response.json({ error: "down" }, { status: 503 }),
		});

		expect(await resolveCliGateAccess(NODE)).toBe("approved");
		expect(enrollmentRequests(requests)).toHaveLength(1);
	});

	it("lets the account through when the enrollment read outlasts its deadline", async () => {
		const requests = installControlPlane({
			coreToken: "cloud-token",
			enrollment: () => Response.json({ required: true }),
			hangs: MFA_STATUS_PATH,
		});

		expect(
			await resolveCliGateAccess(NODE, undefined, {
				...CLI_GATE_DEADLINES,
				enrollmentMs: 20,
			})
		).toBe("approved");
		const [enrollment] = enrollmentRequests(requests);
		expect(enrollment?.signal.aborted).toBe(true);
	});

	it("reports a waitlist phase that outlasts its deadline as inconclusive", async () => {
		const requests = installControlPlane({
			coreToken: "cloud-token",
			enrollment: () => Response.json({ required: false }),
			hangs: "/api/waitlist/me",
		});

		expect(
			await resolveCliGateAccess(NODE, undefined, {
				...CLI_GATE_DEADLINES,
				accessMs: 20,
			})
		).toBe("timed_out");
		expect(enrollmentRequests(requests)).toHaveLength(0);
	});

	it("finishes a slow check before the gate's next poll supersedes it", () => {
		expect(
			CLI_GATE_DEADLINES.accessMs + CLI_GATE_DEADLINES.enrollmentMs
		).toBeLessThan(CLI_GATE_POLL_MS);
	});

	it("still checks enrollment when the waitlist bypasses an unlisted node", async () => {
		const requests = installControlPlane({
			coreToken: "cloud-token",
			enrollment: () => Response.json({ required: true }),
			managedOnly: true,
		});

		expect(await resolveCliGateAccess(NODE)).toBe("mfa_enrollment_required");
		expect(
			requests.some(
				(request) =>
					new URL(request.url).pathname === "/api/control-plane/nodes"
			)
		).toBe(true);
		expect(enrollmentRequests(requests)[0]?.headers.get("authorization")).toBe(
			"Bearer cloud-token"
		);
	});

	it("keeps a waitlisted account on the waitlist without asking about enrollment", async () => {
		const requests = installControlPlane({
			coreToken: "cloud-token",
			enrollment: () => Response.json({ required: true }),
			waitlist: "pending",
		});

		expect(await resolveCliGateAccess(NODE)).toBe("pending");
		expect(enrollmentRequests(requests)).toHaveLength(0);
	});

	it("leaves signed-out use alone", async () => {
		const requests = installControlPlane({
			coreToken: null,
			enrollment: () => Response.json({ required: true }),
		});

		expect(await resolveCliGateAccess(NODE)).toBe("approved");
		expect(requests).toHaveLength(1);
		expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/auth/status");
	});
});
