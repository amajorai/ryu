// The sandbox-page transport's per-element guard: a companion that navigates its
// own frame (escaping the page's `connect-src 'none'`) loses the bridge, and a
// handshake re-run on the same element never re-sends the document and nonce.

import { describe, expect, test } from "bun:test";
import { shouldSendSandboxDocument } from "./ExtensionHost.tsx";
import {
	armNavigationTeardown,
	SANDBOX_PAGE_EXPECTED_LOADS,
	SRCDOC_EXPECTED_LOADS,
	sandboxFrameState,
	sendSandboxDocument,
} from "./sandbox-frame-guard.ts";

const ready = { kind: "ryu-sandbox-ready" };

function fireLoads(frame: EventTarget, count: number): void {
	for (let index = 0; index < count; index++) {
		frame.dispatchEvent(new Event("load"));
	}
}

describe("sandboxFrameState navigation guard", () => {
	test("the page load and the companion write load keep the bridge", () => {
		const frame = new EventTarget();
		const state = sandboxFrameState(frame);
		let teardowns = 0;
		state.onNavigated = () => {
			teardowns += 1;
		};
		fireLoads(frame, SANDBOX_PAGE_EXPECTED_LOADS);
		expect(state.navigated).toBe(false);
		expect(teardowns).toBe(0);
	});

	test("a later load is a self-navigation and tears the bridge down once", () => {
		const frame = new EventTarget();
		const state = sandboxFrameState(frame);
		let teardowns = 0;
		state.onNavigated = () => {
			teardowns += 1;
		};
		fireLoads(frame, SANDBOX_PAGE_EXPECTED_LOADS + 1);
		expect(state.navigated).toBe(true);
		expect(teardowns).toBe(1);
		// The eviction's own load (and any further navigation) changes nothing.
		fireLoads(frame, 2);
		expect(teardowns).toBe(1);
		expect(state.onNavigated).toBeNull();
	});

	test("a navigation between effect runs still marks the element", () => {
		const frame = new EventTarget();
		const state = sandboxFrameState(frame);
		state.onNavigated = null;
		fireLoads(frame, SANDBOX_PAGE_EXPECTED_LOADS + 1);
		// The next handshake run reads the same state and refuses to bridge.
		expect(sandboxFrameState(frame).navigated).toBe(true);
	});
});

class FakeFrame extends EventTarget {
	readonly posted: unknown[] = [];
	src = "page";
	readonly contentWindow = {
		postMessage: (message: unknown) => {
			this.posted.push(message);
		},
	};
	srcdoc: string | null = null;
	setAttribute(_name: string, value: string) {
		this.src = value;
	}
	removeAttribute(name: string) {
		if (name === "srcdoc") {
			this.srcdoc = null;
		}
	}
}

const doc = { srcdoc: "<p>companion</p>", nonce: "n-1" };

describe("sandbox document handoff is once per iframe element", () => {
	test("a handshake re-run on the same element does not re-send the document", () => {
		const frame = new FakeFrame();
		const event = { data: ready, source: frame.contentWindow };
		expect(
			sendSandboxDocument(sandboxFrameState(frame), event, frame, doc)
		).toBe(true);
		// e.g. `granted` changed: the effect runs again for the SAME element, and
		// the frame (possibly now a navigated document) announces readiness again.
		expect(
			sendSandboxDocument(sandboxFrameState(frame), event, frame, doc)
		).toBe(false);
		expect(frame.posted).toEqual([
			{ html: doc.srcdoc, kind: "ryu-sandbox-document", nonce: doc.nonce },
		]);
	});

	test("the srcdoc transport and foreign windows never get the document", () => {
		const frame = new FakeFrame();
		const event = { data: ready, source: frame.contentWindow };
		expect(sendSandboxDocument(null, event, frame, doc)).toBe(false);
		const foreign = { data: ready, source: {} };
		expect(
			sendSandboxDocument(sandboxFrameState(frame), foreign, frame, doc)
		).toBe(false);
		expect(frame.posted).toEqual([]);
		expect(
			shouldSendSandboxDocument(ready, {
				alreadySent: false,
				fromThisFrame: true,
			})
		).toBe(true);
	});

	test("a new iframe element starts with a fresh handoff", () => {
		const first = sandboxFrameState(new EventTarget());
		first.documentSent = true;
		first.portTransferred = true;
		const remounted = sandboxFrameState(new EventTarget());
		expect(remounted.documentSent).toBe(false);
		expect(remounted.portTransferred).toBe(false);
		expect(remounted.navigated).toBe(false);
	});
});

describe("armNavigationTeardown", () => {
	test("a navigation runs the live run's teardown and blanks the frame", () => {
		const frame = new FakeFrame();
		let teardowns = 0;
		armNavigationTeardown(
			sandboxFrameState(frame),
			frame as unknown as Element,
			() => {
				teardowns += 1;
			}
		);
		fireLoads(frame, SANDBOX_PAGE_EXPECTED_LOADS + 1);
		expect(teardowns).toBe(1);
		expect(frame.src).toBe("about:blank");
	});

	test("a disarmed run is not torn down by a later navigation", () => {
		const frame = new FakeFrame();
		let teardowns = 0;
		const disarm = armNavigationTeardown(
			sandboxFrameState(frame),
			frame as unknown as Element,
			() => {
				teardowns += 1;
			}
		);
		disarm();
		fireLoads(frame, SANDBOX_PAGE_EXPECTED_LOADS + 1);
		expect(teardowns).toBe(0);
		expect(frame.src).toBe("page");
	});
});

describe("srcdoc transport navigation guard", () => {
	test("the companion's own load keeps the bridge; the next load tears it down", () => {
		const frame = new FakeFrame();
		frame.srcdoc = "<p>companion</p>";
		const state = sandboxFrameState(frame, SRCDOC_EXPECTED_LOADS);
		let teardowns = 0;
		armNavigationTeardown(state, frame as unknown as Element, () => {
			teardowns += 1;
		});
		fireLoads(frame, SRCDOC_EXPECTED_LOADS);
		expect(teardowns).toBe(0);
		expect(frame.srcdoc).toBe("<p>companion</p>");
		fireLoads(frame, 1);
		expect(teardowns).toBe(1);
		expect(state.navigated).toBe(true);
		// `srcdoc` wins over `src`, so it must go for the blank to take effect.
		expect(frame.srcdoc).toBeNull();
		expect(frame.src).toBe("about:blank");
	});
});
