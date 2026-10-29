import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// The webapp's post-sign-in node choice runs against the node store and the
// `test_node` probe. Both are replaced with a recording fake so the test sees
// exactly which node the store ends up defaulting to.
interface FakeNode {
	name: string;
	url: string;
}

const LOCAL = { name: "local", url: "http://127.0.0.1:7980" };
const AUTH_URL = "https://core.example.test/";

const calls: string[] = [];
let nodes: FakeNode[] = [];
let defaultNode: string | null = null;
let probe: (name: string) => Promise<{ online: boolean }> = async () => ({
	online: false,
});

const fakeStore = {
	get nodes() {
		return nodes;
	},
	addNode: async (name: string, url: string) => {
		calls.push(`add:${name}`);
		nodes = [...nodes, { name, url }];
	},
	setDefault: async (name: string) => {
		calls.push(`default:${name}`);
		defaultNode = name;
	},
	refresh: async () => {
		calls.push("refresh");
	},
};

mock.module("@/src/store/useNodeStore.ts", () => ({
	LOCAL_FALLBACK: LOCAL,
	useNodeStore: { getState: () => fakeStore },
}));
mock.module("@/lib/core-url.ts", () => ({ AUTH_CORE_URL: AUTH_URL }));
mock.module("@/src/lib/tauri-ready.ts", () => ({
	invokeWhenReady: async (command: string, args: { name: string }) => {
		calls.push(`${command}:${args.name}`);
		return await probe(args.name);
	},
}));

const sessionValues = new Map<string, string>();
const previousSessionStorage = Reflect.get(globalThis, "sessionStorage");
Reflect.set(globalThis, "sessionStorage", {
	getItem: (key: string) => sessionValues.get(key) ?? null,
	setItem: (key: string, value: string) => {
		sessionValues.set(key, value);
	},
});

const previousSurface = process.env.VITE_RYU_SURFACE;

const {
	markLocalNudgeShown,
	preferLocalCoreIfReachable,
	preferLocalOrCloud,
	shouldNudgeLocalMissing,
} = await import("./prefer-local-node.ts");

beforeEach(() => {
	process.env.VITE_RYU_SURFACE = "webapp";
	calls.length = 0;
	nodes = [];
	defaultNode = null;
	probe = async () => ({ online: false });
	sessionValues.clear();
});

afterAll(() => {
	if (previousSurface === undefined) {
		Reflect.deleteProperty(process.env, "VITE_RYU_SURFACE");
	} else {
		process.env.VITE_RYU_SURFACE = previousSurface;
	}
	Reflect.set(globalThis, "sessionStorage", previousSessionStorage);
});

describe("preferLocalOrCloud", () => {
	test("is a no-op on the desktop surface", async () => {
		process.env.VITE_RYU_SURFACE = "desktop";
		expect(await preferLocalOrCloud()).toBe("skipped");
		expect(await preferLocalCoreIfReachable()).toBe(false);
		expect(calls).toEqual([]);
		expect(nodes).toEqual([]);
	});

	test("a reachable local Core becomes the default", async () => {
		probe = async (name) => ({ online: name === "local" });

		expect(await preferLocalOrCloud()).toBe("local");
		expect(defaultNode).toBe("local");
		expect(nodes.map((n) => n.name)).toEqual(["local"]);
		expect(calls).toEqual([
			"add:local",
			"test_node:local",
			"default:local",
			"refresh",
		]);
	});

	test("probes an existing local node under its own name instead of adding one", async () => {
		nodes = [{ name: "my-mac", url: "http://127.0.0.1:7980/" }];
		probe = async (name) => ({ online: name === "my-mac" });

		expect(await preferLocalOrCloud()).toBe("local");
		expect(defaultNode).toBe("my-mac");
		expect(calls).not.toContain("add:local");
	});

	test("an unreachable local Core falls back to the cloud node, added once", async () => {
		expect(await preferLocalOrCloud()).toBe("cloud");
		expect(defaultNode).toBe("cloud");
		expect(nodes).toEqual([LOCAL, { name: "cloud", url: AUTH_URL }]);

		// Return visit: neither node is duplicated and cloud stays the default.
		expect(await preferLocalOrCloud()).toBe("cloud");
		expect(nodes).toHaveLength(2);
		expect(calls.filter((c) => c.startsWith("add:"))).toEqual([
			"add:local",
			"add:cloud",
		]);
		expect(defaultNode).toBe("cloud");
	});

	test("a failing probe is treated as offline, not thrown", async () => {
		probe = () => Promise.reject(new Error("bridge down"));
		expect(await preferLocalOrCloud()).toBe("cloud");
		expect(defaultNode).toBe("cloud");
	});

	test("an existing cloud node keeps its own name as the default", async () => {
		nodes = [{ name: "hosted", url: "https://core.example.test" }];
		expect(await preferLocalOrCloud()).toBe("cloud");
		expect(defaultNode).toBe("hosted");
		expect(calls).not.toContain("add:cloud");
	});
});

describe("local-missing nudge", () => {
	test("is shown once per tab session", () => {
		expect(shouldNudgeLocalMissing()).toBe(true);
		markLocalNudgeShown();
		expect(sessionValues.get("ryu_webapp_local_nudge")).toBe("shown");
		expect(shouldNudgeLocalMissing()).toBe(false);
	});
});
