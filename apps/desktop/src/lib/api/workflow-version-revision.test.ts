import { afterEach, expect, test } from "bun:test";
import { createWorkflowVersion } from "./workflows.ts";

const originalFetch = globalThis.fetch;
const target = { token: null, url: "https://node.test" };

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("workflow checkpoint caller sends the acknowledged opaque revision and supports legacy requests", async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return Response.json({ success: true });
		},
		{ preconnect: originalFetch.preconnect }
	);
	await createWorkflowVersion(
		target,
		"workflow",
		"Reviewed",
		"opaque/revision:2"
	);
	await createWorkflowVersion(target, "workflow");
	expect(
		calls.map(({ url, init }) => ({
			url,
			method: init?.method,
			body: JSON.parse(String(init?.body)),
		}))
	).toEqual([
		{
			url: "https://node.test/workflows/workflow/versions",
			method: "POST",
			body: { label: "Reviewed", expectedRevision: "opaque/revision:2" },
		},
		{
			url: "https://node.test/workflows/workflow/versions",
			method: "POST",
			body: {},
		},
	]);
});

test("workflow checkpoint caller exposes the exact revision conflict", async () => {
	const message =
		"workflow revision conflict: it was changed since it was saved";
	globalThis.fetch = Object.assign(
		async () =>
			Response.json(
				{
					success: false,
					code: "workflow_revision_conflict",
					error: message,
					current_updated_at: "revision-3",
				},
				{ status: 409 }
			),
		{ preconnect: originalFetch.preconnect }
	);
	await expect(
		createWorkflowVersion(target, "workflow", undefined, "revision-2")
	).rejects.toThrow(message);
});
