import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { BrowserBotLiveView } = await import("./browser-bot-live-view.tsx");

const BASE = "/api/ext/@ryu/browser";
const TAB = `${BASE}/lanes/agent-a/tabs/t1`;
const HEADERS = { Authorization: "Bearer node-token" };
const REASON = '<img src=x onerror="alert(1)"> Sign in to mail.test';

interface Recorded {
	body: unknown;
	headers: unknown;
	method: string;
	path: string;
}

let container: HTMLDivElement;
let root: Root;
let calls: Recorded[];
/** What the fake sidecar holds for the lane: no request, pending or active. */
let takeover: "active" | "none" | "pending";
/** The HTTP status the next answer to the request fails with, if any. */
let refuseAnswer: string | null;

function lanesReply(): unknown {
	return {
		lanes: [
			{
				agent_id: "agent-a",
				tabs: [{ id: "t1", title: "Sign in", url: "https://mail.test/login" }],
				...(takeover === "none"
					? {}
					: {
							takeover: {
								expires_at: "2026-11-17T12:10:00.000Z",
								reason: REASON,
								requested_at: "2026-11-17T12:00:00.000Z",
								status: takeover,
								tab_id: "t1",
							},
						}),
			},
		],
	};
}

function fakeCall(path: string, init?: RequestInit): Promise<Response> {
	const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
	calls.push({
		body,
		headers: init?.headers,
		method: init?.method ?? "GET",
		path,
	});
	if (path === `${BASE}/lanes`) {
		return Promise.resolve(Response.json(lanesReply()));
	}
	if (path === `${TAB}/screencast`) {
		return Promise.resolve(
			Response.json({
				ok: true,
				frame: {
					captured_at: "2026-11-17T12:00:00.000Z",
					height: 600,
					image: "AAAA",
					mime: "image/jpeg",
					seq: 1,
					via: "screencast",
					width: 1200,
				},
			})
		);
	}
	if (path === `${TAB}/takeover`) {
		if (refuseAnswer) {
			return Promise.reject(new Error(refuseAnswer));
		}
		const action = (body as { action: string }).action;
		takeover = action === "accept" ? "active" : "none";
		return Promise.resolve(Response.json({ ok: true }));
	}
	if (path === `${TAB}/input`) {
		return takeover === "active"
			? Promise.resolve(Response.json({ ok: true }))
			: Promise.reject(new Error("409"));
	}
	return Promise.reject(new Error("404"));
}

async function settle(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

function render(): void {
	act(() => {
		root.render(
			<BrowserBotLiveView
				active
				base={BASE}
				call={fakeCall}
				headers={HEADERS}
			/>
		);
	});
}

function button(label: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === label
	);
}

async function click(label: string): Promise<void> {
	const target = button(label);
	if (!target) {
		throw new Error(`button "${label}" not found`);
	}
	await act(async () => {
		target.click();
		await Promise.resolve();
	});
	await settle();
}

function surface(): HTMLElement | null {
	return container.querySelector('[data-testid="bot-takeover-surface"]');
}

function sent(kind: "input" | "takeover"): Recorded[] {
	return calls.filter((call) => call.path === `${TAB}/${kind}`);
}

beforeEach(() => {
	calls = [];
	takeover = "pending";
	refuseAnswer = null;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

test("shows the agent's request with its reason as plain text", async () => {
	render();
	await settle();
	expect(container.textContent).toContain(
		"agent-a asks you to take over this tab"
	);
	expect(container.textContent).toContain(REASON);
	// The reason never becomes markup: the only picture is the live frame.
	expect(container.querySelectorAll("img")).toHaveLength(1);
	expect(container.textContent).toContain("Needs you");
	expect(button("Take control")).toBeDefined();
	expect(button("Decline")).toBeDefined();
	expect(button("Done")).toBeUndefined();
	// Still read-only: nothing forwards input before the owner takes control.
	expect(surface()).toBe(null);
	expect(container.textContent).toContain("read-only");
});

test("shows no card when the agent has not asked", async () => {
	takeover = "none";
	render();
	await settle();
	expect(button("Take control")).toBeUndefined();
	expect(container.textContent).not.toContain("Needs you");
	expect(surface()).toBe(null);
});

test("takes control, forwards input, and is read-only again after Done", async () => {
	render();
	await settle();
	await click("Take control");
	expect(sent("takeover")[0]).toMatchObject({
		body: { action: "accept" },
		headers: {
			Authorization: "Bearer node-token",
			"Content-Type": "application/json",
		},
		method: "POST",
	});
	const target = surface();
	expect(target).not.toBe(null);
	expect(target?.getAttribute("role")).toBe("application");
	expect(container.textContent).toContain("You have control of this tab");
	expect(container.textContent).not.toContain("read-only");

	await act(async () => {
		target?.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				code: "KeyH",
				key: "h",
			})
		);
		await Promise.resolve();
	});
	await settle();
	expect(sent("input")).toHaveLength(1);
	expect(sent("input")[0]).toMatchObject({
		body: {
			events: [{ action: "down", code: "KeyH", key: "h", type: "key" }],
		},
		headers: { Authorization: "Bearer node-token" },
		method: "POST",
	});

	await click("Done");
	expect(sent("takeover").at(-1)?.body).toEqual({ action: "done" });
	expect(surface()).toBe(null);
	expect(button("Done")).toBeUndefined();
	expect(container.textContent).toContain("read-only");
});

test("F6 leaves the page for the Done button and is never sent to it", async () => {
	takeover = "active";
	render();
	await settle();
	const target = surface();
	target?.focus();
	await act(async () => {
		for (const type of ["keydown", "keyup"]) {
			target?.dispatchEvent(
				new KeyboardEvent(type, {
					bubbles: true,
					cancelable: true,
					code: "F6",
					key: "F6",
				})
			);
		}
		await Promise.resolve();
	});
	await settle();
	expect(sent("input")).toEqual([]);
	expect(document.activeElement).toBe(button("Done") ?? null);
});

test("declines without ever forwarding input", async () => {
	render();
	await settle();
	await click("Decline");
	expect(sent("takeover").map((call) => call.body)).toEqual([
		{ action: "decline" },
	]);
	expect(sent("input")).toEqual([]);
	expect(surface()).toBe(null);
	expect(button("Take control")).toBeUndefined();
});

test("says so when the agent is still working, and stays read-only", async () => {
	refuseAnswer = "423";
	render();
	await settle();
	await click("Take control");
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"The agent is still working in this tab. Try again in a moment."
	);
	expect(surface()).toBe(null);
	expect(button("Take control")).toBeDefined();
});

test("goes back to read-only when the sidecar ends the takeover", async () => {
	takeover = "active";
	render();
	await settle();
	const target = surface();
	expect(target).not.toBe(null);
	// The request ran out on the sidecar: the next input is refused.
	takeover = "none";
	await act(async () => {
		target?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "a" })
		);
		await Promise.resolve();
	});
	await settle();
	expect(surface()).toBe(null);
	expect(container.textContent).toContain("read-only");
});
