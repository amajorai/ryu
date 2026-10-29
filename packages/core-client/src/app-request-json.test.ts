import { expect, test } from "bun:test";
import {
	type AppRequestMethod,
	mountedAppRequest,
	requestValidatedMountedApp,
	validateMountedAppRequest,
} from "./app-request.ts";
import {
	type AppRequestValue,
	appJsonValueSchema,
	appRequestValueSchema,
	appResponseValueSchema,
} from "./app-request-json.ts";

const target = { token: null, url: "https://sidecar.test" };
const policy = {
	mount: "/api/app",
	allowedMethods: new Set<AppRequestMethod>(["GET", "POST"]),
	invalidMethodMessage: () => "invalid method",
	invalidPathMessage: () => "invalid path",
};
test("native serialization values retain optional fields, non-finite numbers, and references", () => {
	const raw = {
		omitted: undefined,
		numbers: [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		],
		future: { nested: [null, true, "value"] },
	};
	expect(appRequestValueSchema.parse(raw)).toBe(raw);
	expect(JSON.stringify(appRequestValueSchema.parse(raw))).toBe(
		'{"numbers":[null,null,null,null],"future":{"nested":[null,true,"value"]}}'
	);
	expect(
		validateMountedAppRequest({ path: "/future", body: raw }, policy).body
	).toBe(raw);
});
test("request and response validators retain every own __proto__ entry", () => {
	const raw = JSON.parse(
		'{"__proto__":{"__proto__":{"future":[true]}},"ordinary":1}'
	);
	expect(appRequestValueSchema.parse(raw)).toBe(raw);
	expect(appResponseValueSchema.parse(raw)).toBe(raw);
	const invalid = JSON.parse('{"__proto__":{"__proto__":null}}');
	Object.defineProperty(invalid.__proto__, "__proto__", {
		value: () => "not serializable",
		enumerable: true,
	});
	expect(appRequestValueSchema.safeParse(invalid).success).toBe(false);
	expect(appResponseValueSchema.safeParse(invalid).success).toBe(false);
});
test("responses preserve all JSON roots and native empty replies", () => {
	for (const raw of [
		undefined,
		null,
		true,
		42,
		"subtitle",
		[1, null],
		{ future: 1 },
	]) {
		expect(Object.is(appResponseValueSchema.parse(raw), raw)).toBe(true);
	}
	expect(appResponseValueSchema.safeParse({ invalid: undefined }).success).toBe(
		false
	);
	expect(
		appResponseValueSchema.safeParse({ invalid: Number.NaN }).success
	).toBe(false);
});
test("custom transports receive decoded requests and return actual original replies", async () => {
	const body = { future: { value: undefined }, array: [undefined] };
	const reply = { future: { array: [null] } };
	let calls = 0;
	const result = await mountedAppRequest(
		target,
		{ path: "/records", method: "POST", body },
		policy,
		{
			request: async (_target, input) => {
				calls++;
				expect(input.path).toBe("/api/app/records");
				expect(input.body).toBe(body);
				return reply;
			},
			isRetryableReadError: () => false,
		}
	);
	expect(result).toBe(reply);
	expect(calls).toBe(1);
});
test("raw SDK failures preserve their identity through custom retry classification", async () => {
	const failure = { future: { retry: true } };
	let calls = 0;
	const result = await requestValidatedMountedApp(
		target,
		{ path: "/api/app/status", method: "GET" },
		{
			request: async () => {
				if (calls++ === 0) {
					throw failure;
				}
				return { ready: true };
			},
			isRetryableReadError: (error) => {
				expect(error).toBe(failure);
				return true;
			},
		}
	);
	expect(result).toEqual({ ready: true });
	expect(calls).toBe(2);
});
test("cancellation preserves primitive and native object reasons without narrowing", async () => {
	for (const reason of [
		"closed",
		42,
		{ future: { abort: true } },
		new Error("closed"),
	]) {
		const controller = new AbortController();
		controller.abort(reason);
		let invoked = false;
		await expect(
			requestValidatedMountedApp(
				target,
				{ path: "/api/app/status", method: "GET", signal: controller.signal },
				{
					request: async () => {
						invoked = true;
						return null;
					},
					isRetryableReadError: () => false,
				}
			)
		).rejects.toBe(reason);
		expect(invoked).toBe(false);
	}
});

test("native HTTP transport preserves serialized request bytes and JSON/no-content replies", async () => {
	const bodies: string[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			bodies.push(await request.text());
			if (request.url.endsWith("/empty")) {
				return new Response(null, { status: 204 });
			}
			return Response.json({ future: { roots: [null, false, [1]] } });
		},
	});
	try {
		const raw = appRequestValueSchema.parse(
			JSON.parse('{"__proto__":{"future":true},"ordinary":1}')
		);
		const httpTarget = { token: null, url: server.url.toString() };
		const result = await mountedAppRequest(
			httpTarget,
			{
				path: "/reply",
				method: "POST",
				body: {
					raw,
					omitted: undefined,
					numbers: [Number.NaN, Number.POSITIVE_INFINITY, undefined],
				},
			},
			policy
		);
		expect(bodies[0]).toBe(
			'{"raw":{"__proto__":{"future":true},"ordinary":1},"numbers":[null,null,null]}'
		);
		expect(result).toEqual({ future: { roots: [null, false, [1]] } });
		expect(
			await mountedAppRequest(httpTarget, { path: "/empty" }, policy)
		).toBeUndefined();
	} finally {
		server.stop(true);
	}
});

test("cancellation during retry preserves an arbitrary native SDK reason", async () => {
	const controller = new AbortController();
	const reason = { future: { closed: true } };
	let calls = 0;
	await expect(
		requestValidatedMountedApp(
			target,
			{ path: "/api/app/status", method: "GET", signal: controller.signal },
			{
				request: async () => {
					calls++;
					queueMicrotask(() => controller.abort(reason));
					throw new Error("startup pending");
				},
				isRetryableReadError: () => true,
			}
		)
	).rejects.toBe(reason);
	expect(calls).toBe(1);
});

const transportSchemas = [
	appRequestValueSchema,
	appResponseValueSchema,
	appJsonValueSchema,
];
const deepShapes = [
	{ open: "[", close: "]" },
	{ open: '{"future":', close: "}" },
	{ open: '{"__proto__":', close: "}" },
];
function nestedJson(open: string, close: string, depth: number) {
	return JSON.parse(`${open.repeat(depth)}0${close.repeat(depth)}`);
}
/**
 * Runs `run` with only `frames` stack frames of headroom left, so a depth-bound
 * walk fails at a small, fixed tree depth instead of at this engine's full
 * stack size. Recurse until the stack overflows, then call `run` while
 * unwinding the same frames; the headroom is identical on every engine.
 */
function withStackHeadroom<T>(frames: number, run: () => T): T {
	let unwound = -1;
	let outcome: { value: T } | undefined;
	const exhaust = (): void => {
		try {
			exhaust();
		} catch (error) {
			if (unwound >= 0 || !(error instanceof RangeError)) {
				throw error;
			}
			unwound = 0;
			return;
		}
		unwound += 1;
		if (unwound === frames) {
			outcome = { value: run() };
		}
	};
	exhaust();
	if (!outcome) {
		throw new Error(`Stack headroom of ${frames} frames was never reached`);
	}
	return outcome.value;
}
/** What a straightforward recursive JSON validator does with each level. */
function recursiveJsonWalk(value: AppRequestValue): boolean {
	if (Array.isArray(value)) {
		return value.every((entry) => recursiveJsonWalk(entry));
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value).every((entry) => recursiveJsonWalk(entry));
	}
	return true;
}
const STACK_HEADROOM_FRAMES = 1000;
const DEEP_TREE_DEPTH = 4000;

// The pass criterion of the deep-tree cases is work, not wall time: a fixed
// tree depth under fixed stack headroom, and an exact read count per level.
// Their 60 s timeouts only guard against a hang on a loaded host.

test("native JSON transport accepts deep trees without cloning their roots", () => {
	// 4,000 levels under 1,000 frames of stack headroom is beyond any recursive
	// walk, whatever the engine's full stack size.
	const recursiveProbe = nestedJson("[", "]", DEEP_TREE_DEPTH);
	expect(() =>
		withStackHeadroom(STACK_HEADROOM_FRAMES, () =>
			recursiveJsonWalk(recursiveProbe)
		)
	).toThrow(RangeError);
	for (const { open, close } of deepShapes) {
		const raw = nestedJson(open, close, DEEP_TREE_DEPTH);
		for (const schema of transportSchemas) {
			expect(
				withStackHeadroom(STACK_HEADROOM_FRAMES, () => schema.parse(raw))
			).toBe(raw);
		}
	}
}, 60_000);

/** A chain of `depth` containers whose every read is counted. */
function countedChain(
	shape: "array" | "object" | "own __proto__",
	depth: number
) {
	const counter = { operations: 0 };
	const handler: ProxyHandler<
		AppRequestValue[] | Record<string, AppRequestValue>
	> = {
		get(target, key, receiver) {
			counter.operations += 1;
			return Reflect.get(target, key, receiver);
		},
		getOwnPropertyDescriptor(target, key) {
			counter.operations += 1;
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		ownKeys(target) {
			counter.operations += 1;
			return Reflect.ownKeys(target);
		},
	};
	type Container = AppRequestValue[] | Record<string, AppRequestValue>;
	let root: AppRequestValue = 0;
	for (let level = 0; level < depth; level++) {
		let container: Container;
		if (shape === "array") {
			container = [root];
		} else if (shape === "object") {
			container = { future: root };
		} else {
			container = JSON.parse('{"__proto__":0}');
			Object.defineProperty(container, "__proto__", {
				configurable: true,
				enumerable: true,
				value: root,
				writable: true,
			});
		}
		root = new Proxy<Container>(container, handler);
	}
	return { counter, root };
}

test("native JSON transport validates deep trees with linear work", () => {
	for (const shape of ["array", "object", "own __proto__"] as const) {
		for (const schema of transportSchemas) {
			const operations = [500, 1000, 1500].map((depth) => {
				const { counter, root } = countedChain(shape, depth);
				expect(schema.parse(root)).toBe(root);
				return counter.operations;
			});
			const [shallow = 0, middle = 0, deep = 0] = operations;
			// Every further 500 levels cost exactly the same reads: no level is
			// revisited, so the cost of a deep tree grows linearly with its size.
			expect(deep - middle).toBe(middle - shallow);
			expect((middle - shallow) / 500).toBeLessThanOrEqual(8);
		}
	}
}, 60_000);

test("response admission retains native exponent overflow and rejects non-JSON leaves", () => {
	for (const text of ["1e400", "-1e400", '{"future":[1e400,-1e400]}']) {
		const raw = JSON.parse(text);
		expect(appRequestValueSchema.parse(raw)).toBe(raw);
		expect(appResponseValueSchema.parse(raw)).toBe(raw);
		expect(appJsonValueSchema.safeParse(raw).success).toBe(false);
	}
	for (const raw of [Number.NaN, { future: undefined }, { future: 1n }]) {
		expect(appResponseValueSchema.safeParse(raw).success).toBe(false);
	}
	const invalid = JSON.parse('{"__proto__":null}');
	Object.defineProperty(invalid, "__proto__", {
		value: undefined,
		enumerable: true,
	});
	expect(appRequestValueSchema.parse(invalid)).toBe(invalid);
	expect(appResponseValueSchema.safeParse(invalid).success).toBe(false);
});

test("transport rejects cycles while preserving shared subtrees", () => {
	const branch = { future: [null, true, "value"] };
	const shared = { left: branch, right: branch };
	for (const schema of [
		appRequestValueSchema,
		appResponseValueSchema,
		appJsonValueSchema,
	]) {
		expect(schema.parse(shared)).toBe(shared);
		const cycle: AppRequestValue[] = [shared];
		cycle.push(cycle);
		expect(schema.safeParse(cycle).success).toBe(false);
		const prototypeCycle = JSON.parse('{"__proto__":null}');
		Object.defineProperty(prototypeCycle, "__proto__", {
			value: prototypeCycle,
			enumerable: true,
		});
		expect(schema.safeParse(prototypeCycle).success).toBe(false);
	}
});

test("HTTP replies retain deep parsed trees and native exponent overflow", async () => {
	const deep = `${"[".repeat(15_000)}1e400${"]".repeat(15_000)}`;
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response(deep, { headers: { "Content-Type": "application/json" } }),
	});
	try {
		const result = await mountedAppRequest(
			{ token: null, url: server.url.toString() },
			{ path: "/deep" },
			policy
		);
		expect(appResponseValueSchema.parse(result)).toBe(result);
		let leaf = result;
		for (let depth = 0; depth < 15_000; depth++) {
			if (!Array.isArray(leaf)) {
				throw new Error("Missing native JSON array");
			}
			leaf = leaf[0];
		}
		expect(leaf).toBe(Number.POSITIVE_INFINITY);
	} finally {
		server.stop(true);
	}
}, 60_000);

test("wide native JSON arrays do not depend on JavaScript argument-count limits", () => {
	const raw = JSON.parse(`[${"0,".repeat(149_999)}0]`);
	for (const schema of [
		appRequestValueSchema,
		appResponseValueSchema,
		appJsonValueSchema,
	]) {
		expect(schema.parse(raw)).toBe(raw);
	}
});
