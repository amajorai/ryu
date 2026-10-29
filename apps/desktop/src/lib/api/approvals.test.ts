import { describe, expect, it } from "bun:test";
import { approvalsListPath } from "./approvals.ts";

describe("approvalsListPath", () => {
	it("opts in to app-job approvals, which Core omits for released clients", () => {
		expect(approvalsListPath()).toBe("/api/approvals?include=app_jobs");
	});

	it("keeps the status filter alongside the opt-in", () => {
		expect(approvalsListPath("pending")).toBe(
			"/api/approvals?status=pending&include=app_jobs"
		);
	});
});
