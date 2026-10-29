import { expect, test } from "bun:test";
import {
	reportUpdateStartup,
	type UpdateStartupBridge,
} from "./update-startup.ts";

test("ordinary startup performs no paint wait or acknowledgement", async () => {
	const calls: string[] = [];
	await reportUpdateStartup({
		bridge: {
			acknowledge: () => {
				calls.push("ack");
				return Promise.resolve(true);
			},
			health: () => Promise.resolve(null),
		},
		paint: () => {
			calls.push("paint");
			return Promise.resolve();
		},
		signal: new AbortController().signal,
	});
	expect(calls).toEqual([]);
});

test("runtime health and mounted paint precede acknowledgement", async () => {
	const calls: string[] = [];
	let acknowledged = false;
	await reportUpdateStartup({
		bridge: {
			acknowledge: () => {
				calls.push("ack");
				acknowledged = true;
				return Promise.resolve(true);
			},
			health: () => {
				calls.push("health");
				return Promise.resolve(acknowledged ? null : true);
			},
		},
		paint: () => {
			calls.push("paint");
			return Promise.resolve();
		},
		signal: new AbortController().signal,
	});
	expect(calls).toEqual(["health", "paint", "ack", "health"]);
});

test("unmount during health query cancels paint and acknowledgement", async () => {
	const controller = new AbortController();
	const calls: string[] = [];
	await reportUpdateStartup({
		bridge: {
			acknowledge: () => {
				calls.push("ack");
				return Promise.resolve(true);
			},
			health: () => {
				controller.abort();
				return Promise.resolve(true);
			},
		},
		paint: () => {
			calls.push("paint");
			return Promise.resolve();
		},
		signal: controller.signal,
	});
	expect(calls).toEqual([]);
});

test("unmount before painting finishes never publishes renderer health", async () => {
	const controller = new AbortController();
	let acknowledged = false;
	await reportUpdateStartup({
		bridge: {
			acknowledge: () => {
				acknowledged = true;
				return Promise.resolve(true);
			},
			health: () => Promise.resolve(true),
		},
		paint: () => {
			controller.abort();
			return Promise.resolve();
		},
		signal: controller.signal,
	});
	expect(acknowledged).toBe(false);
});

test("runtime losing readiness at acknowledgement is checked again", async () => {
	let healthChecks = 0;
	let acknowledgements = 0;
	const bridge: UpdateStartupBridge = {
		acknowledge: () => Promise.resolve(++acknowledgements === 2),
		health: () => {
			healthChecks += 1;
			return Promise.resolve(acknowledgements === 2 ? null : true);
		},
	};
	await reportUpdateStartup({
		bridge,
		paint: () => Promise.resolve(),
		signal: new AbortController().signal,
	});
	expect(healthChecks).toBe(3);
	expect(acknowledgements).toBe(2);
});

test("acknowledgement does not admit work before durable commit", async () => {
	let acknowledged = false;
	let committed = false;
	let finished = false;
	const controller = new AbortController();
	const result = reportUpdateStartup({
		bridge: {
			acknowledge: () => {
				acknowledged = true;
				return Promise.resolve(true);
			},
			health: () => Promise.resolve(committed ? null : true),
		},
		paint: () => Promise.resolve(),
		signal: controller.signal,
	}).then(() => {
		finished = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(acknowledged).toBe(true);
	expect(finished).toBe(false);
	committed = true;
	await result;
	expect(finished).toBe(true);
});

test("a failed native readiness query cannot publish health", async () => {
	let acknowledged = false;
	await expect(
		reportUpdateStartup({
			bridge: {
				acknowledge: () => {
					acknowledged = true;
					return Promise.resolve(true);
				},
				health: () => Promise.reject(new Error("owned runtime unavailable")),
			},
			paint: () => Promise.resolve(),
			signal: new AbortController().signal,
		})
	).rejects.toThrow("owned runtime unavailable");
	expect(acknowledged).toBe(false);
});

test("missing commit fails even after healthy acknowledgement", async () => {
	let acknowledged = false;
	await expect(
		reportUpdateStartup({
			bridge: {
				acknowledge: () => {
					acknowledged = true;
					return Promise.resolve(true);
				},
				health: () => Promise.resolve(true),
			},
			paint: () => Promise.resolve(),
			signal: new AbortController().signal,
			timeoutMilliseconds: 25,
		})
	).rejects.toThrow("before its deadline");
	expect(acknowledged).toBe(true);
});
