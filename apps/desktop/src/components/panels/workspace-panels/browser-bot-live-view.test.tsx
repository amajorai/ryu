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
const SCREENCAST = `${BASE}/lanes/agent-a/tabs/t1/screencast`;

interface Recorded {
	method: string;
	path: string;
}

let container: HTMLDivElement;
let root: Root;
let calls: Recorded[];

function jsonResponse(body: unknown): Response {
	return Response.json(body);
}

function fakeCall(path: string, init?: RequestInit): Promise<Response> {
	calls.push({ method: init?.method ?? "GET", path });
	if (path === `${BASE}/lanes`) {
		return Promise.resolve(
			jsonResponse({
				lanes: [
					{
						agent_id: "agent-a",
						tabs: [{ id: "t1", title: "Inbox", url: "https://mail.test/" }],
					},
				],
			})
		);
	}
	if (path === SCREENCAST && init?.method === "DELETE") {
		return Promise.resolve(jsonResponse({ ok: true, stopped: true }));
	}
	if (path === SCREENCAST) {
		return Promise.resolve(
			jsonResponse({
				ok: true,
				frame: {
					captured_at: "2026-11-02T00:00:00.000Z",
					height: 720,
					image: "AAAA",
					mime: "image/jpeg",
					seq: 1,
					via: "screencast",
					width: 1280,
				},
			})
		);
	}
	return Promise.reject(new Error("404"));
}

async function settle(): Promise<void> {
	for (let index = 0; index < 6; index += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

beforeEach(() => {
	calls = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

test("watches the first agent tab read-only and releases it on close", async () => {
	act(() => {
		root.render(<BrowserBotLiveView active base={BASE} call={fakeCall} />);
	});
	await settle();
	const image = container.querySelector("img");
	expect(image?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
	expect(image?.getAttribute("alt")).toBe("Live view of Inbox");
	expect(container.textContent).toContain("agent-a");
	expect(container.textContent).toContain("read-only");
	// Only lane listing and frame reads: the view never drives the lane.
	expect(
		calls.every(
			(call) =>
				call.method === "GET" &&
				(call.path === `${BASE}/lanes` || call.path === SCREENCAST)
		)
	).toBe(true);
	act(() => root.unmount());
	expect(calls.at(-1)).toEqual({ method: "DELETE", path: SCREENCAST });
	root = createRoot(container);
});

test("polls nothing while the panel is hidden", async () => {
	act(() => {
		root.render(
			<BrowserBotLiveView active={false} base={BASE} call={fakeCall} />
		);
	});
	await settle();
	expect(calls).toEqual([]);
	expect(container.textContent).toContain("No agent is using the browser.");
});
