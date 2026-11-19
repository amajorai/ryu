import { describe, expect, test } from "bun:test";
import { localizedTextOf } from "./localizedText.ts";
import {
	guardSignals,
	IsolationCancelledError,
	newIsolationId,
	ownerLifetimeSeconds,
	validateImageRef,
} from "./vaultIsolation-host.ts";

describe("isolation host helpers", () => {
	test("ids, owner lifetime and image references", () => {
		expect(newIsolationId()).toMatch(/^[0-9a-f]{16}$/u);
		expect(ownerLifetimeSeconds(undefined, 0)).toBe(86_400);
		expect(ownerLifetimeSeconds("1970-01-01T00:10:00Z", 0)).toBe(660);
		expect(validateImageRef("alpine:3")).toBe("alpine:3");
		let caught: unknown;
		try {
			validateImageRef("bad ref");
		} catch (error) {
			caught = error;
		}
		expect((caught as Error).message).toBe(
			'--image "bad ref" is not a valid image reference.'
		);
		expect(localizedTextOf(caught as Error)?.source).toBe(
			"--image {ref} is not a valid image reference."
		);
	});

	test("a signal before the command starts cancels setup", () => {
		const handlers: ((signal: string) => void)[] = [];
		const guard = guardSignals({
			onSignal: (next: (signal: string) => void) => {
				handlers.push(next);
				return () => undefined;
			},
		} as unknown as Parameters<typeof guardSignals>[0]);
		handlers[0]?.("SIGINT");
		expect(() => guard.throwIfCancelled()).toThrow(IsolationCancelledError);
	});
});
