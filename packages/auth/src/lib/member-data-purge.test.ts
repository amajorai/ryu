import { afterEach, describe, expect, it } from "bun:test";
import {
	cancelMemberDataPurgeOnRejoin,
	type MemberDataPurgeRequest,
	type MemberRejoinRequest,
	registerMemberDataPurgeCanceller,
	registerMemberDataPurgeScheduler,
	scheduleMemberDataPurge,
} from "./member-data-purge.ts";

const request: MemberDataPurgeRequest = {
	organizationId: "org-1",
	reason: "member_removed",
	userId: "user-1",
};

afterEach(() => {
	registerMemberDataPurgeScheduler(null);
	registerMemberDataPurgeCanceller(null);
});

describe("scheduleMemberDataPurge", () => {
	it("is a no-op until a scheduler is registered", async () => {
		expect(await scheduleMemberDataPurge(request)).toBe(false);
	});

	it("hands the request to the registered scheduler", async () => {
		const seen: MemberDataPurgeRequest[] = [];
		registerMemberDataPurgeScheduler(async (input) => {
			seen.push(input);
		});
		expect(await scheduleMemberDataPurge(request)).toBe(true);
		expect(seen).toEqual([request]);
	});

	it("never rejects when the scheduler fails", async () => {
		registerMemberDataPurgeScheduler(() =>
			Promise.reject(new Error("queue unavailable"))
		);
		expect(await scheduleMemberDataPurge(request)).toBe(false);
	});

	it("keeps only the last registration", async () => {
		const calls: string[] = [];
		registerMemberDataPurgeScheduler(async () => {
			calls.push("first");
		});
		registerMemberDataPurgeScheduler(async () => {
			calls.push("second");
		});
		await scheduleMemberDataPurge(request);
		expect(calls).toEqual(["second"]);
	});
});

describe("cancelMemberDataPurgeOnRejoin", () => {
	const rejoin: MemberRejoinRequest = {
		organizationId: "org-1",
		userId: "user-1",
	};

	it("is a no-op until a canceller is registered", async () => {
		expect(await cancelMemberDataPurgeOnRejoin(rejoin)).toBe(false);
	});

	it("hands the rejoin to the registered canceller", async () => {
		const seen: MemberRejoinRequest[] = [];
		registerMemberDataPurgeCanceller(async (input) => {
			seen.push(input);
		});
		expect(await cancelMemberDataPurgeOnRejoin(rejoin)).toBe(true);
		expect(seen).toEqual([rejoin]);
	});

	it("never rejects when the canceller fails", async () => {
		registerMemberDataPurgeCanceller(() =>
			Promise.reject(new Error("queue unavailable"))
		);
		expect(await cancelMemberDataPurgeOnRejoin(rejoin)).toBe(false);
	});
});
