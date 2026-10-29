import { describe, expect, test } from "bun:test";
import type { WaitlistGateState } from "./waitlist-gate.ts";
import {
	nextWaitlistManagedOnly,
	resolveWaitlistSurface,
	waitlistApprovedKeyForUser,
	waitlistScopeForNode,
} from "./waitlist-gate.ts";

describe("managed-only scope polling", () => {
	test("a failed read keeps the last known scope and a real read wins", () => {
		expect(nextWaitlistManagedOnly(true, null)).toBe(true);
		expect(nextWaitlistManagedOnly(false, null)).toBe(false);
		expect(nextWaitlistManagedOnly(true, false)).toBe(false);
		expect(nextWaitlistManagedOnly(false, true)).toBe(true);
	});

	test("the first read fails closed to all-node gating", () => {
		expect(nextWaitlistManagedOnly(null, null)).toBe(false);
		expect(nextWaitlistManagedOnly(null, true)).toBe(true);
	});

	test("a failed poll leaves a pending user's local node in the app", () => {
		const local = { managed: false };
		const state: WaitlistGateState = { scope: "local" };
		const managedOnly = nextWaitlistManagedOnly(true, null);
		expect(resolveWaitlistSurface({ managedOnly, node: local, state })).toBe(
			"app"
		);
	});
});

describe("server-scoped waitlist gate", () => {
	test("the default all-node scope applies to managed and local nodes", () => {
		expect(waitlistScopeForNode({ managed: true }, false)).toBe("all");
		expect(waitlistScopeForNode({ managed: false }, false)).toBe("all");
		expect(waitlistScopeForNode({}, false)).toBe("all");
		expect(
			resolveWaitlistSurface({
				managedOnly: false,
				node: { managed: false },
				state: { scope: "all", status: "pending" },
			})
		).toBe("waitlisted");
	});

	test("managed-only scope bypasses local and connected nodes", () => {
		const pending = {
			scope: "managed",
			status: "pending",
		} satisfies WaitlistGateState;

		expect(waitlistScopeForNode({ managed: false }, true)).toBe("local");
		expect(waitlistScopeForNode({}, true)).toBe("local");
		expect(
			resolveWaitlistSurface({
				managedOnly: true,
				node: { managed: false },
				state: pending,
			})
		).toBe("app");
	});

	test("waits until the server flag resolves", () => {
		expect(waitlistScopeForNode({ managed: false }, null)).toBe("loading");
		expect(
			resolveWaitlistSurface({
				managedOnly: null,
				node: { managed: false },
				state: { scope: "all", status: "approved" },
			})
		).toBe("loading");
	});

	test("waitlist state must match the active server scope", () => {
		const allPending = {
			scope: "all",
			status: "pending",
		} satisfies WaitlistGateState;
		const managedPending = {
			scope: "managed",
			status: "pending",
		} satisfies WaitlistGateState;
		const managedApproved = {
			scope: "managed",
			status: "approved",
		} satisfies WaitlistGateState;

		expect(
			resolveWaitlistSurface({
				managedOnly: true,
				node: { managed: true },
				state: allPending,
			})
		).toBe("loading");
		expect(
			resolveWaitlistSurface({
				managedOnly: true,
				node: { managed: true },
				state: managedPending,
			})
		).toBe("waitlisted");
		expect(
			resolveWaitlistSurface({
				managedOnly: true,
				node: { managed: true },
				state: managedApproved,
			})
		).toBe("app");
	});

	test("a cached approval for this account renders the app while checks resolve", () => {
		expect(
			resolveWaitlistSurface({
				cachedApproved: true,
				managedOnly: null,
				node: { managed: true },
				state: { scope: "all", status: "loading" },
			})
		).toBe("app");
		expect(
			resolveWaitlistSurface({
				cachedApproved: true,
				managedOnly: false,
				node: { managed: true },
				state: { scope: "all", status: "pending" },
			})
		).toBe("waitlisted");
	});

	test("approval markers are scoped per account", () => {
		expect(waitlistApprovedKeyForUser("user-a")).not.toBe(
			waitlistApprovedKeyForUser("user-b")
		);
	});
});
