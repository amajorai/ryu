import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PrimaryBotControl } from "./PrimaryBotControl.tsx";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const originalFetch = globalThis.fetch;
const target = { url: "https://primary.test", token: "node-token" };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	container?.remove();
	globalThis.fetch = originalFetch;
});
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 25));
	});
}

test("rendered primary star switches and clears through revision-checked production API", async () => {
	let selection = {
		agentId: "scout" as string | null,
		effectiveAgentId: "scout",
		revision: 3,
		source: "selected",
		unavailableReason: null,
	};
	const writes: unknown[] = [];
	globalThis.fetch = (async (_input, init) => {
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body));
			writes.push(body);
			selection = {
				...selection,
				agentId: body.agentId,
				effectiveAgentId: body.agentId ?? "ryu",
				revision: selection.revision + 1,
				source: body.agentId ? "selected" : "default",
			};
		}
		return Response.json(selection);
	}) as typeof fetch;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<PrimaryBotControl
					agentId="builder"
					agentName="Builder"
					target={target}
				/>
			</QueryClientProvider>
		)
	);
	await settle();
	let button = container.querySelector("button")!;
	expect(button.getAttribute("aria-label")).toBe("Make Builder primary bot");
	await act(async () => button.click());
	await settle();
	button = container.querySelector("button")!;
	expect(writes[0]).toEqual({ agentId: "builder", expectedRevision: 3 });
	expect(button.getAttribute("aria-pressed")).toBe("true");
	expect(button.getAttribute("aria-label")).toBe(
		"Clear Builder as primary bot"
	);
	expect(
		button.querySelector("svg")?.classList.contains("text-status-warning")
	).toBe(true);
	button.focus();
	expect(document.activeElement).toBe(button);
	await act(async () => button.click());
	await settle();
	expect(writes[1]).toEqual({ agentId: null, expectedRevision: 4 });
	expect(button.getAttribute("aria-pressed")).toBe("false");
});

test("concurrent selection conflict reads back winner and leaves actionable error", async () => {
	let reads = 0;
	globalThis.fetch = (async (_input, init) => {
		if (init?.method === "PUT") {
			return Response.json(
				{
					code: "primary_bot_revision_conflict",
					error: "Primary bot changed. Refresh and try again.",
				},
				{ status: 409 }
			);
		}
		reads += 1;
		return Response.json({
			agentId: reads > 1 ? "builder" : "scout",
			effectiveAgentId: reads > 1 ? "builder" : "scout",
			revision: reads > 1 ? 5 : 3,
			source: "selected",
			unavailableReason: null,
		});
	}) as typeof fetch;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<PrimaryBotControl
					agentId="builder"
					agentName="Builder"
					target={target}
				/>
			</QueryClientProvider>
		)
	);
	await settle();
	await act(async () => container.querySelector("button")!.click());
	await settle();
	expect(container.querySelector("button")?.getAttribute("aria-pressed")).toBe(
		"true"
	);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"Refresh and try again"
	);
	expect(reads).toBeGreaterThan(1);
});
