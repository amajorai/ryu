import { expect, test } from "bun:test";
import { coalesceCalls } from "./coalesce-calls.ts";

function deferredRuns() {
	const resolvers: Array<() => void> = [];
	const run = () =>
		new Promise<void>((resolve) => {
			resolvers.push(resolve);
		});
	return { resolvers, run };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a burst of calls during one run costs exactly one more run", async () => {
	const { resolvers, run } = deferredRuns();
	const trigger = coalesceCalls(run);

	trigger();
	for (let i = 0; i < 10; i++) {
		trigger();
	}
	expect(resolvers.length).toBe(1);

	resolvers[0]?.();
	await settle();
	expect(resolvers.length).toBe(2);

	resolvers[1]?.();
	await settle();
	expect(resolvers.length).toBe(2);
});

test("a call after the runs settle starts a new run", async () => {
	const { resolvers, run } = deferredRuns();
	const trigger = coalesceCalls(run);
	trigger();
	resolvers[0]?.();
	await settle();
	trigger();
	expect(resolvers.length).toBe(2);
});

test("a failed run still releases the queued rerun", async () => {
	let calls = 0;
	let fail: (() => void) | undefined;
	const trigger = coalesceCalls(() => {
		calls += 1;
		return calls === 1
			? new Promise<void>((_, reject) => {
					fail = () => reject(new Error("offline"));
				})
			: Promise.resolve();
	});
	trigger();
	trigger();
	fail?.();
	await settle();
	expect(calls).toBe(2);
});
