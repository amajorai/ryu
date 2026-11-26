// apps/desktop/src/components/settings/ShadowCaptureConsent.test.tsx
//
// The capture consent step for Shadow. What these tests hold:
// - a profile without a record shows every kind off and changes nothing on mount;
// - each switch sends its own kind and nothing else;
// - turning a kind off says where its recordings are;
// - a failed load or a failed save never shows a kind as on.
//
// Mocking: the Core client module is replaced by a stand-in that throws, and
// every test passes its own fake through the `api` prop, so no request leaves
// the test and no capture can start.

import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type {
	ShadowCaptureConsent as ConsentState,
	ShadowCaptureKind,
} from "@/src/lib/api/shadow-capture-consent.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

mock.module("@/src/lib/api/shadow-capture-consent.ts", () => ({
	getShadowCaptureConsent: () => {
		throw new Error("the test must pass its own api");
	},
	setShadowCaptureConsent: () => {
		throw new Error("the test must pass its own api");
	},
}));

const { createRoot } = await import("react-dom/client");
const { ShadowCaptureConsent } = await import("./ShadowCaptureConsent.tsx");

const KINDS: ShadowCaptureKind[] = [
	"screen",
	"microphone",
	"input",
	"activity",
];
const DATA_DIR = "/profile/services/shadow";

function consent(
	on: ShadowCaptureKind[],
	extra: Partial<ConsentState> = {}
): ConsentState {
	const kind = (name: ShadowCaptureKind) => ({
		enabled: on.includes(name),
		decided: on.includes(name),
		decidedAt: on.includes(name) ? "2026-11-18T12:00:00Z" : null,
		configured: false,
	});
	return {
		version: 1,
		recordState: on.length > 0 ? "ok" : "missing",
		kinds: {
			screen: kind("screen"),
			microphone: kind("microphone"),
			input: kind("input"),
			activity: kind("activity"),
		},
		storage: {
			dataDir: DATA_DIR,
			screen: [`${DATA_DIR}/media/video`, `${DATA_DIR}/media/keyframes`],
			microphone: [`${DATA_DIR}/media/audio`],
			input: [`${DATA_DIR}/events`],
			activity: [`${DATA_DIR}/events`],
		},
		shadowRunning: true,
		...extra,
	};
}

interface Call {
	enabled: boolean;
	kind: ShadowCaptureKind;
}

/** A fake Core: keeps the kinds that are on and records every change. */
function fakeApi(start: ShadowCaptureKind[] = []) {
	const on = new Set<ShadowCaptureKind>(start);
	const calls: Call[] = [];
	const state = { loads: 0, failLoad: false, failSet: false };
	const current = () => KINDS.filter((kind) => on.has(kind));
	return {
		calls,
		state,
		api: {
			load: async () => {
				state.loads += 1;
				if (state.failLoad) {
					throw new Error("Core answered 503");
				}
				return consent(current());
			},
			set: async (kind: ShadowCaptureKind, enabled: boolean) => {
				calls.push({ kind, enabled });
				if (state.failSet) {
					throw new Error("could not save capture consent");
				}
				if (enabled) {
					on.add(kind);
				} else {
					on.delete(kind);
				}
				return consent(current(), { applied: "restarted" });
			},
		},
	};
}

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

async function settle() {
	await act(async () => {
		await Promise.resolve();
	});
}

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(node);
	});
	await settle();
}

const byTestId = (id: string) =>
	document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const toggle = (kind: ShadowCaptureKind) =>
	byTestId(`shadow-capture-consent-${kind}`);
const isOn = (kind: ShadowCaptureKind) =>
	toggle(kind)?.getAttribute("aria-checked") === "true";
const onKinds = () => KINDS.filter(isOn);

async function click(kind: ShadowCaptureKind) {
	await act(async () => {
		toggle(kind)?.click();
	});
	await settle();
}

test("a profile without a record shows every kind off and changes nothing", async () => {
	const fake = fakeApi();
	await mount(<ShadowCaptureConsent api={fake.api} />);
	expect(byTestId("shadow-capture-consent")).not.toBeNull();
	for (const kind of KINDS) {
		expect(toggle(kind)).not.toBeNull();
	}
	expect(onKinds()).toEqual([]);
	expect(fake.state.loads).toBe(1);
	expect(fake.calls).toEqual([]);
});

test("the step names what is captured and where it is stored", async () => {
	const fake = fakeApi();
	await mount(<ShadowCaptureConsent api={fake.api} />);
	const text = byTestId("shadow-capture-consent")?.textContent ?? "";
	expect(text).toContain("Shadow captures nothing until you turn a kind on");
	expect(text).toContain(DATA_DIR);
	expect(text).toContain("Sound from your microphone");
	expect(text).toContain("Which key was pressed is never recorded");
});

for (const kind of KINDS) {
	test(`the ${kind} switch turns on ${kind} and nothing else`, async () => {
		const fake = fakeApi();
		await mount(<ShadowCaptureConsent api={fake.api} />);
		await click(kind);
		expect(fake.calls).toEqual([{ kind, enabled: true }]);
		expect(onKinds()).toEqual([kind]);
	});
}

test("turning a kind off says where its recordings are", async () => {
	const fake = fakeApi(["screen", "microphone"]);
	await mount(<ShadowCaptureConsent api={fake.api} />);
	expect(onKinds()).toEqual(["screen", "microphone"]);
	expect(byTestId("shadow-capture-consent-turned-off")).toBeNull();
	await click("microphone");
	expect(fake.calls).toEqual([{ kind: "microphone", enabled: false }]);
	expect(onKinds()).toEqual(["screen"]);
	const notice = byTestId("shadow-capture-consent-turned-off");
	expect(notice?.textContent).toContain(`${DATA_DIR}/media/audio`);
	expect(notice?.textContent).toContain("delete");
});

test("a failed load shows no switch and can be retried", async () => {
	const fake = fakeApi(["screen"]);
	fake.state.failLoad = true;
	await mount(<ShadowCaptureConsent api={fake.api} />);
	expect(byTestId("shadow-capture-consent-load-error")).not.toBeNull();
	expect(byTestId("shadow-capture-consent")).toBeNull();
	expect(fake.calls).toEqual([]);
	fake.state.failLoad = false;
	await act(async () => {
		byTestId("shadow-capture-consent-load-error")
			?.querySelector("button")
			?.click();
	});
	await settle();
	expect(byTestId("shadow-capture-consent-load-error")).toBeNull();
	expect(onKinds()).toEqual(["screen"]);
});

test("a save Core refuses leaves the kind off and says so", async () => {
	const fake = fakeApi();
	fake.state.failSet = true;
	await mount(<ShadowCaptureConsent api={fake.api} />);
	await click("screen");
	expect(fake.calls).toEqual([{ kind: "screen", enabled: true }]);
	expect(onKinds()).toEqual([]);
	expect(
		byTestId("shadow-capture-consent-change-error")?.textContent
	).toContain("could not save capture consent");
});

test("a Shadow that could not restart is reported, not hidden", async () => {
	const stopped = {
		load: async () => consent([]),
		set: async () => consent(["screen"], { applied: "stopped" }),
	};
	await mount(<ShadowCaptureConsent api={stopped} />);
	await click("screen");
	expect(byTestId("shadow-capture-consent-stopped")).not.toBeNull();
	expect(byTestId("shadow-capture-consent-failed")).toBeNull();
});

test("a Shadow that may still capture with the old choices is reported", async () => {
	const failed = {
		load: async () => consent(["screen"]),
		set: async () => consent([], { applied: "failed" }),
	};
	await mount(<ShadowCaptureConsent api={failed} />);
	await click("screen");
	expect(byTestId("shadow-capture-consent-failed")).not.toBeNull();
});

test("an unreadable record shows every kind off and says so", async () => {
	const unusable = {
		load: async () => consent([], { recordState: "unusable" }),
		set: async () => consent([]),
	};
	await mount(<ShadowCaptureConsent api={unusable} />);
	expect(onKinds()).toEqual([]);
	expect(byTestId("shadow-capture-consent-unusable")).not.toBeNull();
});
