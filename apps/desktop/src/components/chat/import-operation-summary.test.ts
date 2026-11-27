// apps/desktop/src/components/chat/import-operation-summary.test.ts
//
// The one status, the progress count and the sentences the import surfaces
// show for the operations they started.

import { describe, expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n";
import type { ImportOutcome } from "@/src/lib/api/import.ts";
import type { Operation } from "@/src/lib/api/operations.ts";
import {
	importEndMessage,
	importTotals,
	summarizeImportOperations,
} from "./import-operation-summary.ts";

const tl = ((message: string) => message) as unknown as LiteralMessage;

function operation(over: Partial<Operation> = {}): Operation {
	return {
		attempt: 1,
		cancelRequested: false,
		createdAt: "2026-11-18T10:00:00.000Z",
		id: "op_1",
		kind: "import.setup",
		progress: { done: 0, total: 0 },
		resumed: false,
		status: "running",
		title: ".claude",
		updatedAt: "2026-11-18T10:00:00.000Z",
		...over,
	};
}

function outcome(status: ImportOutcome["status"], id: string): ImportOutcome {
	return { alreadyExists: false, id, kind: "skill", status, title: id };
}

describe("the imports of one surface, taken together", () => {
	test("a surface without imports has nothing to show", () => {
		expect(summarizeImportOperations([])).toBeNull();
	});

	test("progress is counted across every import", () => {
		const summary = summarizeImportOperations([
			operation({ progress: { done: 4, total: 4 }, status: "succeeded" }),
			operation({ id: "op_2", progress: { done: 1, total: 6 } }),
		]);
		expect(summary?.status).toBe("running");
		expect(summary?.done).toBe(5);
		expect(summary?.total).toBe(10);
	});

	test("only imports that all wait count as waiting", () => {
		expect(
			summarizeImportOperations([operation({ status: "queued" })])?.status
		).toBe("queued");
		// Between two imports of the same surface the first is done and the
		// second has not started. That is still an import in progress.
		expect(
			summarizeImportOperations([
				operation({ status: "succeeded" }),
				operation({ id: "op_2", status: "queued" }),
			])?.status
		).toBe("running");
	});

	test("the worst end is the one reported", () => {
		const ended = (...statuses: Operation["status"][]) =>
			summarizeImportOperations(
				statuses.map((status, index) =>
					operation({ id: `op_${index}`, status })
				)
			)?.status;
		expect(ended("succeeded", "succeeded")).toBe("succeeded");
		expect(ended("succeeded", "cancelled")).toBe("cancelled");
		expect(ended("cancelled", "failed")).toBe("failed");
		expect(ended("failed", "interrupted", "succeeded")).toBe("interrupted");
	});

	test("resumed is shown only while the resumed import still runs", () => {
		expect(
			summarizeImportOperations([operation({ resumed: true })])?.resumed
		).toBe(true);
		expect(
			summarizeImportOperations([
				operation({ resumed: true, status: "succeeded" }),
			])?.resumed
		).toBe(false);
	});

	test("a requested stop shows only while something still runs", () => {
		expect(
			summarizeImportOperations([operation({ cancelRequested: true })])
				?.cancelRequested
		).toBe(true);
		expect(
			summarizeImportOperations([
				operation({ cancelRequested: true, status: "cancelled" }),
			])?.cancelRequested
		).toBe(false);
	});

	test("the error text of a failed import is passed on", () => {
		const summary = summarizeImportOperations([
			operation({ status: "succeeded" }),
			operation({
				error: "The stored import request cannot be read.",
				id: "op_2",
				status: "failed",
			}),
		]);
		expect(summary?.error).toBe("The stored import request cannot be read.");
	});
});

describe("counts and sentences", () => {
	test("outcomes are counted by status", () => {
		expect(
			importTotals([
				outcome("imported", "a"),
				outcome("imported", "b"),
				outcome("skipped", "c"),
				outcome("failed", "d"),
			])
		).toEqual({ failed: 1, imported: 2, skipped: 1 });
		expect(importTotals([])).toEqual({ failed: 0, imported: 0, skipped: 0 });
	});

	test("an import that ended early says what happened and what is kept", () => {
		expect(importEndMessage("interrupted", tl)).toBe(
			"The node restarted during this import. Items already imported are kept."
		);
		expect(importEndMessage("failed", tl)).toBe(
			"The import stopped with an error. Items already imported are kept."
		);
		expect(importEndMessage("cancelled", tl)).toBe(
			"The import was stopped. Items already imported are kept."
		);
	});

	test("a finished or running import needs no such sentence", () => {
		expect(importEndMessage("succeeded", tl)).toBeNull();
		expect(importEndMessage("running", tl)).toBeNull();
		expect(importEndMessage("queued", tl)).toBeNull();
	});
});
