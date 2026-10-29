import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { MessageList } = await import("./message-list.tsx");
const { nextDisplayDayBoundaryMs, resetTimezone, setTimezonePreference } =
	await import("@ryu/ui/lib/timezone.ts");

afterEach(() => {
	setSystemTime();
	resetTimezone();
});
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const wait = (delay: number) =>
	new Promise((resolve) => setTimeout(resolve, delay));

/**
 * Counts only the timers and focus/visibility listeners whose creation stack
 * runs through the shared display-day store, so the transcript's own scroller
 * and animation timers cannot hide or fake the day subscription.
 */
function auditDayResources() {
	const originalSet = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	const originals = [window, document].map((target) => ({
		target,
		add: target.addEventListener,
		remove: target.removeEventListener,
	}));
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const listeners = new Set<EventListenerOrEventListenerObject>();
	const owned = () =>
		new Error("Audit display-day ownership").stack?.includes(
			"/lib/display-day.ts"
		) ?? false;
	globalThis.setTimeout = ((
		handler: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		const track = owned();
		const handle = originalSet(() => {
			timers.delete(handle);
			handler(...args);
		}, delay);
		if (track) {
			timers.add(handle);
		}
		return handle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		timers.delete(handle);
		return originalClear(handle);
	}) as typeof clearTimeout;
	for (const { target, add, remove } of originals) {
		target.addEventListener = function (
			this: EventTarget,
			type: string,
			callback: EventListenerOrEventListenerObject | null,
			options?: AddEventListenerOptions | boolean
		) {
			if (callback && owned() && ["focus", "visibilitychange"].includes(type)) {
				listeners.add(callback);
			}
			if (callback) {
				add.call(this, type, callback, options);
			}
		};
		target.removeEventListener = function (
			this: EventTarget,
			type: string,
			callback: EventListenerOrEventListenerObject | null,
			options?: EventListenerOptions | boolean
		) {
			if (callback) {
				listeners.delete(callback);
				remove.call(this, type, callback, options);
			}
		};
	}
	return {
		counts: () => ({ timers: timers.size, listeners: listeners.size }),
		restore: () => {
			globalThis.setTimeout = originalSet;
			globalThis.clearTimeout = originalClear;
			for (const { target, add, remove } of originals) {
				target.addEventListener = add;
				target.removeEventListener = remove;
			}
		},
	};
}

// New York's spring-forward day is 23 hours long and its fall-back day is 25:
// a separator that assumed a 24-hour day would roll an hour early or late.
for (const [season, boundary, stamp] of [
	["spring-forward", "2026-03-09T04:00:00Z", "2026-03-08T05:30:00Z"],
	["fall-back", "2026-11-02T05:00:00Z", "2026-11-01T04:30:00Z"],
] as const) {
	test(`mounted transcript separator rolls Today to Yesterday at the ${season} display-zone midnight and releases the day wake`, async () => {
		const midnight = Date.parse(boundary);
		const sent = Date.parse(stamp);
		const messages: Array<UIMessage & { createdAt: string }> = [
			{
				id: "retained-user",
				role: "user",
				createdAt: new Date(sent).toISOString(),
				parts: [{ type: "text", text: "Retained midnight question" }],
			},
			{
				id: "retained-assistant",
				role: "assistant",
				createdAt: new Date(sent + 60_000).toISOString(),
				parts: [{ type: "text", text: "Retained midnight answer" }],
			},
		];
		const original = JSON.stringify(messages);
		setSystemTime(midnight - 80);
		setTimezonePreference("America/New_York");
		expect(nextDisplayDayBoundaryMs(midnight - 80)).toBe(midnight);
		const audit = auditDayResources();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const separators = () =>
			[...container.querySelectorAll('[data-slot="chat-date-separator"]')].map(
				(node) => node.textContent
			);
		try {
			await act(async () => {
				root.render(
					<MessageList
						conversationKey="retained-time-conversation"
						initialScrollBehavior="top"
						messages={messages}
						status="ready"
					/>
				);
			});
			expect(separators()).toEqual(["Today"]);
			// No prop, message or parent render changes from here on: only the
			// clock crosses midnight and the shared day wake fires.
			await act(async () => {
				setSystemTime(midnight + 1);
				await wait(120);
			});
			expect(separators()).toEqual(["Yesterday"]);
			expect(container.textContent).toContain("Retained midnight question");
			expect(container.textContent).toContain("Retained midnight answer");
			expect(JSON.stringify(messages)).toBe(original);
			// One shared wake (timer + focus + visibility), however many day
			// consumers are mounted.
			expect(audit.counts()).toEqual({ timers: 1, listeners: 2 });
			await act(async () => {
				root.unmount();
			});
			expect(audit.counts()).toEqual({ timers: 0, listeners: 0 });
		} finally {
			await act(async () => {
				root.unmount();
			});
			container.remove();
			audit.restore();
		}
	});
}
