import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const probes: string[] = [];
let failProbes = false;
let nodeUrl = "https://node.test";
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => ({ token: null, url: nodeUrl, userJwt: null }),
}));
mock.module("@/src/lib/api/usage.ts", () => ({
	fetchAgentUsage: (_target: unknown, id: string) => {
		probes.push(id);
		if (failProbes) {
			return Promise.reject(new Error("probe failed"));
		}
		return Promise.resolve({
			agentId: id,
			available: true,
			engine: "acp",
			extraUsageUsd: null,
			meters: [],
			plan: null,
			reason: null,
			retryAfterSeconds: null,
			windows: [
				{
					label: "Weekly",
					model: null,
					resetsAt: null,
					usedPercent: 100,
					windowSeconds: 604_800,
				},
			],
		});
	},
	supportsUsage: () => true,
}));
const { createRoot } = await import("react-dom/client");
const { pickUsagePolls, USAGE_POLLS_PER_TICK, useInterfaceLimits } =
	await import("./use-interface-limits.ts");

describe("pickUsagePolls", () => {
	test("at most 6 per tick, least recently polled first, urgent first among equals", () => {
		const agents = Array.from({ length: 14 }, (_, i) => ({
			id: `a${String(i).padStart(2, "0")}`,
			urgent: i === 13,
		}));
		const first = pickUsagePolls(agents, new Map());
		expect(first).toHaveLength(USAGE_POLLS_PER_TICK);
		expect(first[0]).toBe("a13");
	});

	test("every agent is reached within ceil(n / 6) ticks", () => {
		const agents = Array.from({ length: 14 }, (_, i) => ({
			id: `a${i}`,
			urgent: false,
		}));
		const polled = new Map<string, number>();
		const seen = new Set<string>();
		const ticks = Math.ceil(agents.length / USAGE_POLLS_PER_TICK);
		for (let tick = 0; tick < ticks; tick += 1) {
			for (const id of pickUsagePolls(agents, polled)) {
				polled.set(id, tick);
				seen.add(id);
			}
		}
		expect(seen.size).toBe(agents.length);
	});
});

describe("useInterfaceLimits", () => {
	let root: ReturnType<typeof createRoot>;
	let client: QueryClient;
	let seen: ReadonlyMap<string, unknown> = new Map();
	const urgent = new Set<string>();
	const eightAgents = () =>
		Array.from({ length: 8 }, (_, i) => ({ id: `a${i}` }));
	beforeEach(() => {
		probes.length = 0;
		failProbes = false;
		nodeUrl = "https://node.test";
		seen = new Map();
		root = createRoot(document.createElement("div"));
		client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	});
	afterEach(() => {
		act(() => root.unmount());
		client.clear();
	});
	function Probe({ agents }: { agents: { id: string }[] }) {
		seen = useInterfaceLimits(true, agents, urgent);
		return null;
	}
	const render = (agents: { id: string }[]) =>
		root.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(Probe, { agents })
			)
		);
	/** Flush React and the query cache until `predicate` holds (or 2s pass). */
	async function waitFor(predicate: () => boolean) {
		const end = Date.now() + 2000;
		while (!predicate()) {
			if (Date.now() > end) {
				throw new Error("useInterfaceLimits fixture timed out");
			}
			await act(async () => {
				await Bun.sleep(5);
			});
		}
	}

	test("polls as soon as the agent list arrives, 6 at a time", async () => {
		await act(async () => render([]));
		expect(probes).toEqual([]);
		await act(async () => render(eightAgents()));
		await waitFor(() => seen.size === USAGE_POLLS_PER_TICK);
		expect(probes).toHaveLength(USAGE_POLLS_PER_TICK);
		expect(seen.get(probes[0] ?? "")).toMatchObject({
			blocked: true,
			label: "Weekly",
		});
	});

	test("a failed refetch reads as unknown, not the old limit", async () => {
		await act(async () => render(eightAgents()));
		await waitFor(() => seen.size === USAGE_POLLS_PER_TICK);
		const first = probes[0] ?? "";
		expect(seen.get(first)).toMatchObject({ blocked: true });
		failProbes = true;
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["agent-usage"] });
		});
		await waitFor(() => seen.get(first) === null);
		expect(seen.get(first)).toBeNull();
	});

	test("a node switch probes the new node at once", async () => {
		await act(async () => render(eightAgents()));
		await waitFor(() => probes.length === USAGE_POLLS_PER_TICK);
		probes.length = 0;
		nodeUrl = "https://other.test";
		await act(async () => render(eightAgents()));
		await waitFor(() => probes.length >= USAGE_POLLS_PER_TICK);
		expect(probes).toHaveLength(USAGE_POLLS_PER_TICK);
	});
});
