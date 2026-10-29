import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Performance panel against the real metrics recorder. The
// samples come from genuine traffic: chat turns streamed through the shipping
// `instrumentedFetch` from an owned native HTTP peer, and Core calls made
// through the shipping `request()` client. The clipboard is the one browser
// boundary replaced, so each case reads exactly what a user would paste.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
const NativeReadableStream = globalThis.ReadableStream;
const NativeTransformStream = globalThis.TransformStream;
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Object.assign(globalThis, {
	Response: NativeResponse,
	fetch: nativeFetch,
	ReadableStream: NativeReadableStream,
	TransformStream: NativeTransformStream,
});
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const DEV_MODE_KEY = "ryu_developer_mode";
const clipboard = { fail: false, text: "", writes: 0 };
const runtimeErrors: string[] = [];
const encoder = new TextEncoder();

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/api/chat") {
			// A streamed turn: the model "thinks" before the first byte, then
			// writes three chunks.
			const chunks = ["data: one\n\n", "data: two\n\n", "data: three\n\n"];
			const body = new NativeReadableStream<Uint8Array>({
				async start(controller) {
					await Bun.sleep(60);
					for (const chunk of chunks) {
						controller.enqueue(encoder.encode(chunk));
						await Bun.sleep(15);
					}
					controller.close();
				},
			});
			return new NativeResponse(body, {
				headers: { "content-type": "text/event-stream" },
			});
		}
		if (url.pathname === "/api/sessions") {
			return Bun.sleep(25).then(() => NativeResponse.json({ sessions: [] }));
		}
		if (url.pathname === "/api/agents/7f3c2b1a-0000-4000-8000-000000000001") {
			return NativeResponse.json({ error: "gone" }, { status: 500 });
		}
		return NativeResponse.json({ error: "undeclared" }, { status: 404 });
	},
});
const closedPort = Bun.serve({ port: 0, fetch: () => new NativeResponse("") });
const closedUrl = closedPort.url.toString().replace(/\/$/, "");
await closedPort.stop(true);

const clipboardDescriptor = Object.getOwnPropertyDescriptor(
	navigator,
	"clipboard"
);
Object.defineProperty(navigator, "clipboard", {
	configurable: true,
	value: {
		readText: async () => clipboard.text,
		writeText: async (value: string) => {
			if (clipboard.fail) {
				throw new Error("Fixture clipboard failure");
			}
			clipboard.writes += 1;
			clipboard.text = value;
		},
	},
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { toast } = await import("@ryu/ui/components/sileo.tsx");
const metrics = await import("@/src/lib/dev-metrics.ts");
const { request } = await import("@/src/lib/api/client.ts");
const { gatewayJsonValueSchema } = await import(
	"@/src/lib/api/gateway-json-contracts.ts"
);
const { DevMetricsPanel } = await import("./DevMetricsPanel.tsx");

const base = server.url.toString().replace(/\/$/, "");
const target = { url: base, token: "metrics-token" };
const roots: ReturnType<typeof createRoot>[] = [];
let errorToast: ReturnType<typeof spyOn<typeof toast, "error">>;
let successToast: ReturnType<typeof spyOn<typeof toast, "success">>;
const onError = (event: ErrorEvent) => runtimeErrors.push(event.message);
const onRejection = (event: PromiseRejectionEvent) =>
	runtimeErrors.push(String(event.reason));

async function mountPanel() {
	const container = document.createElement("section");
	document.body.append(container);
	const root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	roots.push(root);
	await act(async () => root.render(createElement(DevMetricsPanel)));
	return container;
}
async function streamTurn() {
	await act(async () => {
		const response = await metrics.instrumentedFetch(`${base}/api/chat`, {
			method: "POST",
			body: JSON.stringify({ messages: [] }),
		});
		await response.text();
	});
}
/** The headline stats of the "Chat turns" row, keyed by their caption. */
function chatTurnStats(scope: ParentNode): Record<string, string> {
	const heading = [...scope.querySelectorAll('[data-slot="item-title"]')].find(
		(element) => element.textContent?.trim() === "Chat turns"
	);
	const row = heading?.closest('[role="list"]');
	if (!row) {
		throw new Error("Missing Chat turns row");
	}
	const stats: Record<string, string> = {};
	for (const caption of row.querySelectorAll("span.type-caption")) {
		const value = caption.previousElementSibling?.textContent ?? "";
		stats[caption.textContent ?? ""] = value;
	}
	return stats;
}
function tableRows(scope: ParentNode, caption: string): string[][] {
	const card = [...scope.querySelectorAll("p")].find(
		(element) => element.textContent?.trim() === caption
	)?.parentElement;
	return [...(card?.querySelectorAll("tbody tr") ?? [])].map((row) =>
		[...row.querySelectorAll("td")].map((cell) => cell.textContent ?? "")
	);
}
function msValue(value: string): number {
	return value.endsWith("s") && !value.endsWith("ms")
		? Number.parseFloat(value) * 1000
		: Number.parseFloat(value);
}
function button(scope: ParentNode, name: string) {
	const found = [...scope.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === name
	);
	if (!found) {
		throw new Error(`Missing Performance action ${name}`);
	}
	return found;
}

beforeEach(() => {
	runtimeErrors.length = 0;
	clipboard.fail = false;
	clipboard.text = "";
	clipboard.writes = 0;
	localStorage.setItem(DEV_MODE_KEY, "true");
	metrics.refreshDevMetricsGate();
	metrics.clearDevMetrics();
	errorToast = spyOn(toast, "error");
	successToast = spyOn(toast, "success");
	window.addEventListener("error", onError);
	window.addEventListener("unhandledrejection", onRejection);
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	errorToast.mockRestore();
	successToast.mockRestore();
	window.removeEventListener("error", onError);
	window.removeEventListener("unhandledrejection", onRejection);
	if (runtimeErrors.length > 0) {
		throw new Error(`runtime errors: ${runtimeErrors.join("; ")}`);
	}
});
afterAll(async () => {
	await server.stop(true);
	if (clipboardDescriptor) {
		Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	}
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("Chat turns summarises real streamed turns live, with first token apart from the total and a recent-turn row per turn; a turn that never connects is listed as failed", async () => {
	const panel = await mountPanel();
	expect(chatTurnStats(panel)).toEqual({
		turns: "0",
		"first token (median)": "—",
		"first token (p95)": "—",
		"total (median)": "—",
		"total (p95)": "—",
	});
	expect(panel.textContent).not.toContain("Recent turns");

	await streamTurn();
	const stats = chatTurnStats(panel);
	expect(stats.turns).toBe("1");
	const firstToken = msValue(stats["first token (median)"] ?? "");
	const total = msValue(stats["total (median)"] ?? "");
	// The wait before the first byte and the whole turn are measured apart:
	// the peer holds the first chunk ~60ms and streams for ~45ms more.
	expect(firstToken).toBeGreaterThanOrEqual(50);
	expect(total).toBeGreaterThan(firstToken);
	const rows = tableRows(panel, "Recent turns");
	expect(rows).toHaveLength(1);
	expect(rows[0]?.[1]).toBe("200");
	expect(rows[0]?.[4]).toBe(
		`${"data: one\n\ndata: two\n\ndata: three\n\n".length} B`
	);
	expect(rows[0]?.[5]).toBe("3");

	await act(async () => {
		await metrics
			.instrumentedFetch(`${closedUrl}/api/chat`, { method: "POST" })
			.catch(() => undefined);
	});
	expect(chatTurnStats(panel).turns).toBe("2");
	const latest = tableRows(panel, "Recent turns")[0];
	expect(latest?.[1]).toBe("failed");
	expect(latest?.[2]).toBe("—");
	expect(latest?.[4]).toBe("0 B");
	expect(latest?.[5]).toBe("0");

	// Core calls through the shipping client fill the slowest-first table.
	expect(panel.textContent).toContain("Nothing recorded yet.");
	await act(async () => {
		await request(target, "/api/sessions", undefined, gatewayJsonValueSchema);
		await request(
			target,
			"/api/agents/7f3c2b1a-0000-4000-8000-000000000001",
			undefined,
			gatewayJsonValueSchema
		).catch(() => undefined);
	});
	const api = tableRows(panel, "Core API calls — slowest first");
	expect(api.map((row) => row[0])).toEqual([
		"/api/sessions",
		"/api/agents/:id",
	]);
	expect(api[0]?.[1]).toBe("1");
	expect(api[0]?.[5]).toBe("—");
	expect(api[1]?.[5]).toBe("1");
});

test("Copy places the recorded metrics on the clipboard, reports an empty recorder and a clipboard failure, and Clear empties every mounted panel", async () => {
	const first = await mountPanel();
	const second = await mountPanel();
	await act(async () => button(first, "Copy").click());
	expect(errorToast).toHaveBeenCalledWith("No metrics recorded yet");
	expect(clipboard.writes).toBe(0);

	await streamTurn();
	await act(async () => {
		await request(target, "/api/sessions", undefined, gatewayJsonValueSchema);
	});
	expect(chatTurnStats(second).turns).toBe("1");
	clipboard.fail = true;
	await act(async () => button(first, "Copy").click());
	expect(errorToast).toHaveBeenLastCalledWith("Couldn't copy to clipboard");
	expect(clipboard.writes).toBe(0);
	clipboard.fail = false;
	await act(async () => button(first, "Copy").click());
	expect(successToast).toHaveBeenCalledWith(
		"Performance metrics copied to clipboard"
	);
	expect(clipboard.text).toBe(metrics.getDevMetricsText());
	expect(clipboard.text).toContain("chat turns: 1 | first token median");
	expect(clipboard.text).toContain("200 ttft");
	expect(clipboard.text).toContain("/api/sessions ×1");

	await act(async () => button(second, "Clear").click());
	for (const panel of [first, second]) {
		expect(chatTurnStats(panel).turns).toBe("0");
		expect(panel.textContent).not.toContain("Recent turns");
		expect(panel.textContent).toContain("Nothing recorded yet.");
	}
	await act(async () => button(first, "Copy").click());
	expect(errorToast).toHaveBeenLastCalledWith("No metrics recorded yet");
});

test("with Developer Mode off a streamed turn passes through unmetered and the panel stays empty; a remounted panel shows what was recorded while it was away", async () => {
	localStorage.setItem(DEV_MODE_KEY, "false");
	metrics.refreshDevMetricsGate();
	const panel = await mountPanel();
	await streamTurn();
	await act(async () => {
		await request(target, "/api/sessions", undefined, gatewayJsonValueSchema);
	});
	expect(chatTurnStats(panel).turns).toBe("0");
	expect(panel.textContent).toContain("Nothing recorded yet.");

	localStorage.setItem(DEV_MODE_KEY, "true");
	await act(async () => {
		metrics.refreshDevMetricsGate();
	});
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	// Recorded while no panel is mounted; the unmounted panel must not react.
	await streamTurn();
	const remounted = await mountPanel();
	expect(chatTurnStats(remounted).turns).toBe("1");
	expect(tableRows(remounted, "Recent turns")).toHaveLength(1);
});
