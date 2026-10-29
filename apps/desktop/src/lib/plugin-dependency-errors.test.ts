import { expect, test } from "bun:test";
import type { DependencyError } from "./api/plugins.ts";
import { dependencyErrorOf } from "./plugin-dependency-errors.ts";

test("complete Core dependency refusals retain identity and future metadata", () => {
	const refusal = {
		code: "blocked_by_dependents",
		plugin: "com.ryu.meetings",
		dependents: ["com.ryu.whiteboard"],
		future: { advice: "disable dependents first" },
	} satisfies DependencyError & { future: { advice: string } };
	const error = Object.assign(new Error("dependency refusal"), {
		dependencyError: refusal,
	});
	expect(dependencyErrorOf(error)).toBe(refusal);
	expect(error.message).toBe("dependency refusal");
});

test("generic failures and incomplete dependency attachments use the normal error fallback", () => {
	expect(dependencyErrorOf(new Error("offline"))).toBeNull();
	expect(
		dependencyErrorOf({ dependencyError: { code: "cycle", cycle: [] } })
	).toBeNull();
	expect(
		dependencyErrorOf(
			Object.assign(new Error("invalid"), {
				dependencyError: { code: "blocked_by_dependents" },
			})
		)
	).toBeNull();
	expect(
		dependencyErrorOf(
			Object.assign(new Error("future"), {
				dependencyError: { code: "future_failure", plugin: "com.ryu.test" },
			})
		)
	).toBeNull();
});
