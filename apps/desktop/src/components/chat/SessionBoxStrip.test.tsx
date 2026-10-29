import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { parseSessionBoxView } from "@/src/lib/api/session-box.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { SessionBoxSummary } = await import("./SessionBoxStrip.tsx");

const roots: Root[] = [];

function box(overrides: Record<string, unknown> = {}) {
	const view = parseSessionBoxView({
		accruedMicroUsd: 12_300,
		id: "box-1",
		ratePerHourMicroUsd: 41_000,
		runningSeconds: 1080,
		size: "small",
		state: "ready",
		warning: "none",
		...overrides,
	});
	if (!view) {
		throw new Error("fixture did not parse");
	}
	return view;
}

async function render(element: React.ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(element));
	return container;
}

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

test("a running session Box shows its cost and a screen action in the composer", async () => {
	const container = await render(
		<SessionBoxSummary box={box()} conversationId="conv-1" />
	);
	expect(
		container.querySelector('[data-testid="session-box-strip"]')
	).not.toBeNull();
	expect(
		container.querySelector('[data-testid="box-cost-chip"]')?.textContent
	).toContain("$0.0123");
	const view = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("View screen")
	);
	expect(view?.disabled).toBe(false);
	expect(
		container.querySelector('[data-testid="box-credit-banner"]')
	).toBeNull();
});

test("a provisioning Box cannot be viewed yet", async () => {
	const container = await render(
		<SessionBoxSummary
			box={box({ state: "provisioning" })}
			conversationId="conv-1"
		/>
	);
	const view = [...container.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("View screen")
	);
	expect(view?.disabled).toBe(true);
});

test("the low-credit warning shows while the Box runs", async () => {
	const container = await render(
		<SessionBoxSummary
			box={box({ minutesRemaining: 9, warning: "low" })}
			conversationId="conv-1"
		/>
	);
	expect(
		container.querySelector('[data-testid="box-credit-banner"]')?.textContent
	).toContain("about 9 min of Box time left");
});

test("a Box stopped for credit keeps only the exhaustion banner", async () => {
	const container = await render(
		<SessionBoxSummary
			box={box({ state: "parked", stopReason: "balance" })}
			conversationId="conv-1"
		/>
	);
	expect(
		container.querySelector('[data-testid="session-box-strip"]')
	).toBeNull();
	expect(
		container.querySelector('[data-testid="box-credit-banner"]')?.textContent
	).toContain("credits ran out");
});

test("an idle parked Box shows nothing", async () => {
	const container = await render(
		<SessionBoxSummary
			box={box({ state: "parked", stopReason: "idle" })}
			conversationId="conv-1"
		/>
	);
	expect(container.textContent).toBe("");
});

// ── The one-time computer-use cost notice ────────────────────────────────────

const { SessionBoxStripContent } = await import("./SessionBoxStrip.tsx");
const { parseSessionBoxStatus } = await import("@/src/lib/api/session-box.ts");
const originalFetch = globalThis.fetch;
const target = { url: "http://node.test", token: "node", userJwt: "jwt" };

function noticeStatus(rate: number | null = 25_000, waiting = false) {
	return parseSessionBoxStatus({
		conversationId: "conv-1",
		box: null,
		children: [],
		costNotice: {
			required: true,
			size: "small",
			ratePerHourMicroUsd: rate,
			minimumSecondsPerStart: 300,
			waiting,
		},
	});
}

function allowButton(container: HTMLElement) {
	return [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Allow"
	);
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("the first computer-use Box shows its hourly cost and is allowed with the rate shown", async () => {
	const seen: { body: unknown; method: string; path: string }[] = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				body: init?.body ? JSON.parse(String(init.body)) : null,
				method: init?.method ?? "GET",
				path: new URL(String(input)).pathname,
			});
			return Promise.resolve(
				Response.json({
					acknowledged: true,
					acknowledgedAt: "2026-10-20T10:00:00Z",
					ratePerHourMicroUsd: 25_000,
				})
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
	let refetches = 0;
	const container = await render(
		<SessionBoxStripContent
			conversationId="conv-1"
			refetch={() => {
				refetches += 1;
				return Promise.resolve();
			}}
			status={noticeStatus()}
			target={target}
		/>
	);
	const notice = container.querySelector(
		'[data-testid="computer-use-cost-notice"]'
	);
	expect(notice?.textContent).toContain("$0.025/hour");
	expect(notice?.textContent).toContain("small: 2 vCPU, 4 GB");
	expect(notice?.textContent).toContain("Ryu asks once");
	expect(notice?.textContent).toContain("5-minute minimum per start");
	expect(notice?.textContent).toContain(
		"5-minute minimum each time the Box starts; a resume within the hour already paid owes no new minimum"
	);
	await act(async () => {
		allowButton(container)?.click();
	});
	expect(seen).toEqual([
		{
			body: { ratePerHourMicroUsd: 25_000 },
			method: "POST",
			path: "/api/session-boxes/conv-1/cost-notice",
		},
	]);
	expect(refetches).toBe(1);
	// The refetched status no longer carries the notice: the strip says the
	// agent may continue until its Box appears.
	await act(async () =>
		roots
			.at(-1)
			?.render(
				<SessionBoxStripContent
					conversationId="conv-1"
					refetch={() => Promise.resolve()}
					status={null}
					target={target}
				/>
			)
	);
	expect(
		container.querySelector('[data-testid="computer-use-cost-notice"]')
	).toBeNull();
	expect(
		container.querySelector('[data-testid="computer-use-cost-notice-allowed"]')
			?.textContent
	).toContain("Ask the agent to continue");
});

test("allowing a held computer-use call says the Box starts on its own", async () => {
	globalThis.fetch = Object.assign(
		() =>
			Promise.resolve(
				Response.json({
					acknowledged: true,
					acknowledgedAt: "2026-10-20T10:00:00Z",
					ratePerHourMicroUsd: 25_000,
				})
			),
		{ preconnect: originalFetch.preconnect }
	);
	const container = await render(
		<SessionBoxStripContent
			conversationId="conv-1"
			refetch={() => Promise.resolve()}
			status={noticeStatus(25_000, true)}
			target={target}
		/>
	);
	await act(async () => {
		allowButton(container)?.click();
	});
	await act(async () =>
		roots
			.at(-1)
			?.render(
				<SessionBoxStripContent
					conversationId="conv-1"
					refetch={() => Promise.resolve()}
					status={null}
					target={target}
				/>
			)
	);
	expect(
		container.querySelector('[data-testid="computer-use-cost-notice-allowed"]')
			?.textContent
	).toContain("The Box is starting and the agent continues");
});

test("a changed rate is reported and nothing is allowed", async () => {
	globalThis.fetch = Object.assign(
		() =>
			Promise.resolve(
				Response.json(
					{
						error: {
							code: "session_box_rate_changed",
							message: "The Box rate is now $0.03 an hour.",
							ratePerHourMicroUsd: 30_000,
						},
					},
					{ status: 409 }
				)
			),
		{ preconnect: originalFetch.preconnect }
	);
	const container = await render(
		<SessionBoxStripContent
			conversationId="conv-1"
			refetch={() => Promise.resolve()}
			status={noticeStatus()}
			target={target}
		/>
	);
	await act(async () => {
		allowButton(container)?.click();
	});
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"rate changed"
	);
	expect(
		container.querySelector('[data-testid="computer-use-cost-notice-allowed"]')
	).toBeNull();
});

test("without a readable rate the notice cannot be allowed", async () => {
	const container = await render(
		<SessionBoxStripContent
			conversationId="conv-1"
			refetch={() => Promise.resolve()}
			status={noticeStatus(null)}
			target={target}
		/>
	);
	expect(allowButton(container)?.disabled).toBe(true);
	expect(container.textContent).toContain("could not read its hourly rate");
});

test("no notice and no Box renders nothing", async () => {
	const container = await render(
		<SessionBoxStripContent
			conversationId="conv-1"
			refetch={() => Promise.resolve()}
			status={null}
			target={target}
		/>
	);
	expect(container.textContent).toBe("");
});
