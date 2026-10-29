// The run trace waterfall: a nested span tree from Core, with Gateway audit
// usage joined onto model calls, collapsible rows, and a span detail drawer.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function span(
	id: string,
	kind: string,
	startedAt: number,
	endedAt: number,
	children: unknown[] = [],
	extra: Record<string, unknown> = {}
) {
	return {
		id: `row-${id}`,
		conversation_id: "run-1",
		kind,
		name: id,
		args_hash: null,
		started_at: startedAt,
		ended_at: endedAt,
		error: null,
		session_id: kind === "model_call" ? "run-1" : null,
		seq: startedAt,
		trace_id: "a".repeat(32),
		span_id: id,
		parent_span_id: null,
		status: "ok",
		agent_id: "agent-1",
		attributes: {},
		normalized_kind: kind,
		depth: 0,
		offset_ms: startedAt - 1000,
		duration_ms: endedAt - startedAt,
		children,
		...extra,
	};
}

const treeBody = {
	format: "tree",
	run_id: "run-1",
	started_at: 1000,
	ended_at: 3000,
	duration_ms: 2000,
	span_count: 4,
	error_count: 1,
	roots: [
		span("assistant", "agent_run", 1000, 3000, [
			span("gpt-test", "model_call", 1100, 1900, [], { depth: 1 }),
			span(
				"search_docs",
				"tool_call",
				2000,
				2500,
				[
					span("auto-recall", "retrieval", 2100, 2200, [], {
						depth: 2,
						attributes: { hits: 2 },
					}),
				],
				{ depth: 1, status: "error", error: "timeout" }
			),
		]),
	],
};

const auditEntries = [
	{
		id: "audit-1",
		session_id: "run-1",
		event_type: "model_call",
		timestamp: new Date(1900).toISOString(),
		model: "gpt-test",
		input_tokens: 1200,
		output_tokens: 300,
		cost_micro_usd: 4500,
		latency_ms: 700,
	},
];

mock.module("@/src/lib/api/gateway.ts", () => ({
	fetchGatewayAudit: async () => ({
		reachable: true,
		entries: auditEntries,
		count: 1,
	}),
}));

const target = {
	token: "t",
	url: "http://core.test",
	fetch: (async () => Response.json(treeBody)) as unknown as typeof fetch,
};

const { createRoot } = await import("react-dom/client");
const { RunTracePanel, barGeometry, formatDuration } = await import(
	"./RunTracePanel.tsx"
);

let root: Root | undefined;
let host: HTMLElement;

beforeEach(() => {
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	host.remove();
});

async function settle() {
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

function clickButton(label: string) {
	const button = [...host.querySelectorAll("button")].find((element) =>
		element.textContent?.includes(label)
	);
	if (!button) {
		throw new Error(`no button labelled ${label}`);
	}
	return act(async () => button.click());
}

test("renders the span tree with joined usage and collapsible rows", async () => {
	await act(async () =>
		root?.render(<RunTracePanel runId="run-1" target={target} />)
	);
	await settle();
	expect(host.textContent).toContain("4 spans · 1 failed");
	await clickButton("Run trace");
	await settle();
	const rows = () =>
		host.querySelectorAll('[data-testid="trace-waterfall-row"]');
	expect(rows().length).toBe(4);
	expect(host.textContent).toContain("1.5k tokens");
	expect(host.textContent).toContain("$0.0045");

	const collapse = host.querySelectorAll('button[aria-label="Collapse span"]');
	await act(async () => (collapse[1] as HTMLButtonElement).click());
	expect(rows().length).toBe(3);

	await clickButton("search_docs");
	const detail = host.querySelector('[data-testid="trace-span-detail"]');
	expect(detail?.textContent).toContain("timeout");
});

test("bar geometry stays inside the track", () => {
	const node = {
		children: [],
		depth: 0,
		durationMs: null,
		normalizedKind: "tool_call",
		offsetMs: 900,
		span: {} as never,
	};
	expect(barGeometry(node, 1000)).toEqual({ left: 90, width: 10 });
	expect(barGeometry({ ...node, offsetMs: 0, durationMs: 0 }, 1000).width).toBe(
		0.5
	);
	expect(formatDuration(250)).toBe("250ms");
	expect(formatDuration(1500)).toBe("1.50s");
	expect(formatDuration(null)).toBe("in flight");
});
