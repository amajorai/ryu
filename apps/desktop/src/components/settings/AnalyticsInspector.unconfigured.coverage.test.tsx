import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// The REAL inspector in a build with NO PostHog project key (the default for a
// local or self-built desktop). `analytics.ts` reads the key once when it is
// first evaluated, so this is a separate process from the configured suite.
// The inspector must say nothing is sent, and the real `track()` must leave the
// egress record empty however many events the app tries to send.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.deleteProperty(process.env, "VITE_POSTHOG_KEY");

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AnalyticsInspector } = await import("./AnalyticsInspector.tsx");
const { getEgressLog, isAnalyticsConfigured, isAnalyticsEnabled, track } =
	await import("@/src/lib/analytics.ts");
const {
	button,
	dialogDescription,
	flush,
	installAnimationApis,
	isDisabled,
	openDialogs,
	text,
	until,
} = await import("./unswept-a.test-support.ts");
installAnimationApis();

let root: Root | null = null;

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	document.body.replaceChildren();
});

test("without a project key the inspector says nothing is sent and track() never fills the egress log", async () => {
	expect(isAnalyticsConfigured()).toBe(false);
	// Opt-out posture: the gate is on, so only the missing key stops egress.
	expect(isAnalyticsEnabled()).toBe(true);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(<AnalyticsInspector />));
	await act(async () => button("See what we send").click());
	await until(() => openDialogs().length === 1, "inspector open");
	const [dialog] = openDialogs();
	if (!dialog) {
		throw new Error("inspector did not open");
	}
	const description = dialogDescription(dialog);
	expect(description).toContain(
		"No analytics project is configured, so nothing is sent."
	);
	expect(description).not.toContain("A project is configured.");
	expect(description).toContain(
		`${localStorage.getItem("ryu:analytics-install-id")}.`
	);

	track({ event: "agent_installed", agent_id: "agent-alpha" });
	track({ event: "chat_started" });
	expect(getEgressLog()).toEqual([]);
	expect(localStorage.getItem("ryu:analytics-egress-log")).toBeNull();
	await act(async () => button("Refresh").click());
	await flush(2);
	expect(text()).toContain("Egress log (0)");
	expect(text()).toContain("Nothing sent yet.");
	expect(text()).not.toContain("agent_id=agent-alpha");
	expect(isDisabled(button("Clear log"))).toBe(true);
});
