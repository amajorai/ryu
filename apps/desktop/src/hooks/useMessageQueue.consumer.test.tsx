import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ChatStatus } from "ai";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { UseMessageQueueOptions } from "./useMessageQueue.ts";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { sileo } = await import("sileo");
const { useMessageQueue } = await import("./useMessageQueue.ts");
const { setQueueDrainMode } = await import("./useQueueDrainMode.ts");
const storageKey = "ryu_queue_drain_mode";
const previousMode = localStorage.getItem(storageKey);
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
let current: ReturnType<typeof useMessageQueue>;
let status: ChatStatus = "streaming";
let blocked = false;
let stops = 0;
let sendFailure = false;
let stopFailure = false;
let onSend: (() => void) | undefined;
let deliveries: Parameters<UseMessageQueueOptions["send"]>[0][] = [];
function Consumer() {
	current = useMessageQueue({
		status,
		blocked,
		send(message) {
			if (sendFailure) {
				throw new Error("Queued dispatch refused");
			}
			onSend?.();
			deliveries.push(structuredClone(message));
		},
		stop() {
			if (stopFailure) {
				throw new Error("Run interruption refused");
			}
			stops += 1;
		},
	});
	return createElement("output", null, JSON.stringify(current.queue));
}
async function render() {
	await act(async () =>
		root?.render(
			createElement(
				StrictMode,
				null,
				createElement(Consumer),
				createElement(Toaster)
			)
		)
	);
}
async function mount() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await render();
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	container = undefined;
	status = "streaming";
	blocked = false;
	stops = 0;
	sendFailure = false;
	stopFailure = false;
	onSend = undefined;
	sileo.clear();
	deliveries = [];
	if (previousMode === null) {
		localStorage.removeItem(storageKey);
	} else {
		localStorage.setItem(storageKey, previousMode);
	}
});
const firstAttachment = {
	id: "first-image",
	filename: "first.png",
	mimeType: "image/png",
	size: 11,
	url: "https://example.test/first.png",
};
const secondAttachment = {
	id: "second-image",
	filename: "second.png",
	mimeType: "image/png",
	size: 19,
	url: "https://example.test/second.png",
};

for (const mode of ["send-all", "auto"] as const) {
	test(`${mode} automatically conserves every queued attachment and text exactly once`, async () => {
		setQueueDrainMode(mode);
		await mount();
		await act(async () => {
			current.enqueue(" first ", [firstAttachment]);
			current.enqueue("second", [secondAttachment]);
		});
		expect(deliveries).toEqual([]);
		status = "ready";
		await render();
		expect(deliveries).toEqual([
			{
				role: "user",
				content: "first\n\nsecond",
				attachments: [firstAttachment, secondAttachment],
			},
		]);
		expect(current.queue).toEqual([]);
		await render();
		expect(deliveries).toHaveLength(1);
		expect(container?.querySelector("output")?.textContent).toBe("[]");
	});
}

test("persisted drain-order changes affect the mounted queue and independent remount without redispatch", async () => {
	setQueueDrainMode("oldest-first");
	await mount();
	await act(async () => {
		current.enqueue("oldest", [firstAttachment]);
		current.enqueue("latest", [secondAttachment]);
	});
	const originalSetItem = localStorage.setItem;
	Object.defineProperty(localStorage, "setItem", {
		configurable: true,
		value() {
			throw new Error("Storage write refused");
		},
	});
	try {
		expect(() => setQueueDrainMode("latest-first")).toThrow(
			"Storage write refused"
		);
	} finally {
		Object.defineProperty(localStorage, "setItem", {
			configurable: true,
			value: originalSetItem,
		});
	}
	expect(localStorage.getItem(storageKey)).toBe("oldest-first");
	expect(current.queue.map(({ content }) => content)).toEqual([
		"oldest",
		"latest",
	]);
	await act(async () => setQueueDrainMode("latest-first"));
	expect(localStorage.getItem(storageKey)).toBe("latest-first");
	status = "ready";
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "latest", attachments: [secondAttachment] },
	]);
	expect(current.queue.map(({ content }) => content)).toEqual(["oldest"]);
	await render();
	expect(deliveries).toHaveLength(1);
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	status = "streaming";
	await mount();
	await act(async () => {
		current.enqueue("new-oldest");
		current.enqueue("new-latest");
	});
	status = "ready";
	await render();
	expect(deliveries.map(({ content }) => content)).toEqual([
		"latest",
		"new-latest",
	]);
	expect(current.queue.map(({ content }) => content)).toEqual(["new-oldest"]);
});

test("a forced queued turn survives an interrupted error and preserves unrelated queued turns", async () => {
	setQueueDrainMode("latest-first");
	await mount();
	await act(async () => {
		current.enqueue("first", [firstAttachment]);
		current.enqueue("second", [secondAttachment]);
		current.enqueue("third");
	});
	const selected = current.queue[0];
	if (!selected) {
		throw new Error("Expected queued first turn");
	}
	await act(async () => current.sendNow(selected.id));
	expect(stops).toBe(1);
	expect(deliveries).toEqual([]);
	status = "error";
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "first", attachments: [firstAttachment] },
	]);
	expect(
		current.queue.map(({ content, attachments }) => ({ content, attachments }))
	).toEqual([
		{ content: "second", attachments: [secondAttachment] },
		{ content: "third", attachments: [] },
	]);
	await render();
	expect(deliveries).toHaveLength(1);
});

test("unblocking a completed turn resumes its conserved queue exactly once", async () => {
	setQueueDrainMode("oldest-first");
	await mount();
	await act(async () => {
		current.enqueue("waiting", [firstAttachment]);
		current.enqueue("unrelated", [secondAttachment]);
	});
	blocked = true;
	status = "error";
	await render();
	expect(deliveries).toEqual([]);
	expect(current.queue).toHaveLength(2);
	blocked = false;
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "waiting", attachments: [firstAttachment] },
	]);
	expect(current.queue.map(({ content }) => content)).toEqual(["unrelated"]);
	await render();
	expect(deliveries).toHaveLength(1);
});

for (const action of ["send-now", "send-all"] as const) {
	test(`${action} conserves exact queued records on synchronous refusal and explicit retry removes only accepted records`, async () => {
		setQueueDrainMode("oldest-first");
		status = "ready";
		await mount();
		await act(async () => {
			current.enqueue("first", [firstAttachment]);
			current.enqueue("second", [secondAttachment]);
		});
		const snapshot = structuredClone(current.queue);
		const selected = snapshot[0];
		if (!selected) {
			throw new Error("Missing queued turn");
		}
		sendFailure = true;
		let thrown: unknown;
		await act(async () => {
			try {
				if (action === "send-now") {
					current.sendNow(selected.id);
				} else {
					current.sendAll();
				}
			} catch (error) {
				thrown = error;
			}
		});
		expect(current.queue).toEqual(snapshot);
		expect(thrown).toBeUndefined();
		expect(document.body.textContent).toContain("Queued dispatch refused");
		expect(deliveries).toEqual([]);
		sendFailure = false;
		onSend = () =>
			current.enqueue("arrived during dispatch", [secondAttachment]);
		await act(async () => {
			if (action === "send-now") {
				current.sendNow(selected.id);
			} else {
				current.sendAll();
			}
		});
		expect(deliveries).toEqual([
			{
				role: "user",
				content: action === "send-now" ? "first" : "first\n\nsecond",
				attachments:
					action === "send-now"
						? [firstAttachment]
						: [firstAttachment, secondAttachment],
			},
		]);
		expect(
			current.queue.map(({ content, attachments }) => ({
				content,
				attachments,
			}))
		).toEqual([
			...(action === "send-now"
				? [{ content: "second", attachments: [secondAttachment] }]
				: []),
			{ content: "arrived during dispatch", attachments: [secondAttachment] },
		]);
		await render();
		expect(deliveries).toHaveLength(1);
	});
}

test("a synchronous automatic drain refusal keeps the mounted queue and permits explicit retry", async () => {
	setQueueDrainMode("send-all");
	await mount();
	await act(async () => {
		current.enqueue("first", [firstAttachment]);
		current.enqueue("second", [secondAttachment]);
	});
	const before = structuredClone(current.queue);
	sendFailure = true;
	status = "ready";
	await expect(render()).resolves.toBeUndefined();
	expect(current.queue).toEqual(before);
	expect(container?.querySelector("output")).not.toBeNull();
	expect(document.body.textContent).toContain("Queued dispatch refused");
	expect(deliveries).toEqual([]);
	await render();
	expect(current.queue).toEqual(before);
	sendFailure = false;
	await act(async () => current.sendAll());
	expect(deliveries).toEqual([
		{
			role: "user",
			content: "first\n\nsecond",
			attachments: [firstAttachment, secondAttachment],
		},
	]);
	expect(current.queue).toEqual([]);
});

test("failed interruption preserves every queued ID and attachment before a later explicit force-send", async () => {
	setQueueDrainMode("latest-first");
	await mount();
	await act(async () => {
		current.enqueue("first", [firstAttachment]);
		current.enqueue("second", [secondAttachment]);
	});
	const before = structuredClone(current.queue);
	const selected = before[0];
	if (!selected) {
		throw new Error("Missing queued turn");
	}
	stopFailure = true;
	for (const action of ["send-now", "send-all"] as const) {
		let thrown: unknown;
		await act(async () => {
			try {
				if (action === "send-now") {
					current.sendNow(selected.id);
				} else {
					current.sendAll();
				}
			} catch (error) {
				thrown = error;
			}
		});
		expect(current.queue).toEqual(before);
		expect(thrown).toBeUndefined();
		expect(deliveries).toEqual([]);
		expect(document.body.textContent).toContain("Run interruption refused");
	}
	stopFailure = false;
	await act(async () => current.sendNow(selected.id));
	expect(stops).toBe(1);
	status = "error";
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "first", attachments: [firstAttachment] },
	]);
	expect(current.queue).toEqual([before[1]]);
});

test("cancelling a forced send-now before the interrupted run settles never dispatches it and resumes drain order", async () => {
	setQueueDrainMode("oldest-first");
	await mount();
	await act(async () => {
		current.enqueue("first", [firstAttachment]);
		current.enqueue("forced", [secondAttachment]);
		current.enqueue("third");
	});
	const forced = current.queue[1];
	if (!forced) {
		throw new Error("Missing forced queued turn");
	}
	await act(async () => current.sendNow(forced.id));
	expect(stops).toBe(1);
	expect(current.queue.map(({ content }) => content)).toEqual([
		"forced",
		"first",
		"third",
	]);
	// The user cancels the forced turn while the interrupted run winds down.
	await act(async () => current.remove(forced.id));
	expect(deliveries).toEqual([]);
	status = "ready";
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "first", attachments: [firstAttachment] },
	]);
	expect(current.queue.map(({ content }) => content)).toEqual(["third"]);
	await render();
	expect(deliveries).toHaveLength(1);
	// The cancelled forced ID does not block or alter the next drain either.
	status = "streaming";
	await render();
	status = "ready";
	await render();
	expect(deliveries.map(({ content }) => content)).toEqual(["first", "third"]);
	expect(deliveries.some(({ content }) => content === "forced")).toBe(false);
	expect(current.queue).toEqual([]);
});

test("re-forcing another turn after cancelling a pending send-now dispatches the new choice instead of the drain order", async () => {
	// Latest-first would pick the tail, so only the pending force can select
	// "chosen" at the ready edge.
	setQueueDrainMode("latest-first");
	await mount();
	await act(async () => {
		current.enqueue("first", [firstAttachment]);
		current.enqueue("cancelled");
		current.enqueue("chosen", [secondAttachment]);
		current.enqueue("last");
	});
	const cancelled = current.queue[1];
	const chosen = current.queue[2];
	if (!(cancelled && chosen)) {
		throw new Error("Missing queued turns");
	}
	await act(async () => current.sendNow(cancelled.id));
	await act(async () => current.remove(cancelled.id));
	// Before the interrupted run settles, the user forces a different turn.
	await act(async () => current.sendNow(chosen.id));
	expect(stops).toBe(2);
	expect(deliveries).toEqual([]);
	expect(current.queue.map(({ content }) => content)).toEqual([
		"chosen",
		"first",
		"last",
	]);
	status = "ready";
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "chosen", attachments: [secondAttachment] },
	]);
	expect(current.queue.map(({ content }) => content)).toEqual([
		"first",
		"last",
	]);
	await render();
	expect(deliveries).toHaveLength(1);
	// The consumed force does not persist: the next completed turn follows
	// latest-first again.
	status = "streaming";
	await render();
	status = "ready";
	await render();
	expect(deliveries.map(({ content }) => content)).toEqual(["chosen", "last"]);
	expect(current.queue.map(({ content }) => content)).toEqual(["first"]);
	expect(stops).toBe(2);
});

test("clearing an interrupted send-all cancels every pending turn and a later message drains alone", async () => {
	setQueueDrainMode("oldest-first");
	await mount();
	await act(async () => {
		current.enqueue("first", [firstAttachment]);
		current.enqueue("second", [secondAttachment]);
	});
	await act(async () => current.sendAll());
	expect(stops).toBe(1);
	expect(current.queue).toHaveLength(1);
	expect(current.queue[0]).toMatchObject({
		content: "first\n\nsecond",
		attachments: [firstAttachment, secondAttachment],
	});
	await act(async () => current.clear());
	expect(container?.querySelector("output")?.textContent).toBe("[]");
	status = "ready";
	await render();
	expect(deliveries).toEqual([]);
	status = "streaming";
	await render();
	await act(async () => current.enqueue(" later "));
	status = "ready";
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "later", attachments: [] },
	]);
	expect(current.queue).toEqual([]);
	expect(stops).toBe(1);
});

test("editing a queued turn changes exactly the dispatched text, refuses blank edits and keeps attachments", async () => {
	setQueueDrainMode("oldest-first");
	await mount();
	await act(async () => {
		current.enqueue("draft", [firstAttachment]);
		current.enqueue("unrelated", [secondAttachment]);
	});
	const draft = current.queue[0];
	const unrelated = current.queue[1];
	if (!(draft && unrelated)) {
		throw new Error("Missing queued turns");
	}
	await act(async () => current.edit(draft.id, "   "));
	expect(current.queue[0]).toEqual(draft);
	await act(async () => current.edit(draft.id, " revised draft "));
	expect(current.queue).toEqual([
		{ ...draft, content: "revised draft" },
		unrelated,
	]);
	status = "ready";
	await render();
	expect(deliveries).toEqual([
		{ role: "user", content: "revised draft", attachments: [firstAttachment] },
	]);
	expect(current.queue).toEqual([unrelated]);
});
