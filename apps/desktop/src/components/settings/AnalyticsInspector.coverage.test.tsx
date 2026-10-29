import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// The REAL "See what we send" inspector (rendered by Privacy → Usage & crash
// data), mounted in happy-dom over the REAL analytics module and real
// localStorage. A PostHog project key is configured for this process, so
// `track()` is the production producer of every egress-log entry the inspector
// shows; no entry is hand-written. The PostHog client itself is never
// initialised, and every network request is refused, so nothing leaves the test.
// `AnalyticsInspector.unconfigured.coverage.test.tsx` covers the no-key build.
const nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const refusedEgress: string[] = [];
const refuseFetch = Object.assign(
	(input: RequestInfo | URL) => {
		refusedEgress.push(String(input instanceof Request ? input.url : input));
		return Promise.reject(new Error("analytics inspector test has no network"));
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = refuseFetch;
window.fetch = refuseFetch;
// `analytics.ts` reads the key once, when it is first evaluated.
process.env.VITE_POSTHOG_KEY = "phc_unswept_a_fixture";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AnalyticsInspector } = await import("./AnalyticsInspector.tsx");
const {
	ANALYTICS_EVENT_CATALOG,
	ANALYTICS_EVENT_NAMES,
	getEgressLog,
	isAnalyticsConfigured,
	setAnalyticsEnabled,
	track,
} = await import("@/src/lib/analytics.ts");
const { formatDateTime } = await import("@/src/lib/timezone.ts");
const {
	button,
	dialogDescription,
	dialogName,
	flush,
	installAnimationApis,
	isDisabled,
	maybeButton,
	openDialogs,
	press,
	text,
	until,
} = await import("./unswept-a.test-support.ts");
installAnimationApis();

const EGRESS_KEY = "ryu:analytics-egress-log";
const INSTALL_KEY = "ryu:analytics-install-id";
const UNRELATED_KEY = "ryu:privacy-disclosure-ack";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root?.render(<AnalyticsInspector />));
	await flush();
}

async function unmount(): Promise<void> {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	container?.remove();
	container = null;
}

function inspector(): HTMLElement {
	const [open] = openDialogs();
	if (!open) {
		throw new Error(`Inspector is not open: ${text()}`);
	}
	return open;
}

async function openInspector(): Promise<HTMLElement> {
	await act(async () => button("See what we send").click());
	await until(() => openDialogs().length === 1, "inspector open");
	return inspector();
}

/** Egress rows in display order: [event, timestamp, props] per row. */
function egressRows(): string[][] {
	const scroller = [...inspector().querySelectorAll("section")].at(-1);
	return [...(scroller?.querySelectorAll(".border-b") ?? [])].map((row) =>
		[...row.querySelectorAll("code, span")].map((part) =>
			(part.textContent ?? "").trim()
		)
	);
}

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(UNRELATED_KEY, "true");
	setAnalyticsEnabled(true);
});

afterEach(async () => {
	await unmount();
	document.body.replaceChildren();
	// biome-ignore lint/suspicious/noMisplacedAssertion: no case may send analytics over the network.
	expect(refusedEgress).toEqual([]);
});

afterAll(() => {
	globalThis.fetch = nativeFetch;
	window.fetch = nativeFetch;
});

test("opening discloses the configured project and the persisted install id, and the catalog lists every event with its props", async () => {
	expect(isAnalyticsConfigured()).toBe(true);
	await mount();
	// Nothing is mounted before the trigger is used.
	expect(openDialogs()).toHaveLength(0);
	const dialog = await openInspector();
	expect(dialogName(dialog)).toBe("What product analytics sends");
	const installId = localStorage.getItem(INSTALL_KEY);
	expect(installId).toMatch(/^[0-9a-f-]{36}$/);
	const description = dialogDescription(dialog);
	expect(description).toContain(`not linked to your account): ${installId}.`);
	expect(description).toContain("A project is configured.");
	expect(description).not.toContain("nothing is sent");

	expect(text()).toContain(`Event catalog (${ANALYTICS_EVENT_NAMES.length})`);
	const catalogRows = [
		...(dialog.querySelector("section")?.querySelectorAll(".flex-col") ?? []),
	];
	const byName = new Map(
		catalogRows.map((row) => [row.querySelector("code")?.textContent, row])
	);
	for (const name of ANALYTICS_EVENT_NAMES) {
		const row = byName.get(name);
		const meta = ANALYTICS_EVENT_CATALOG[name];
		expect(row?.textContent).toContain(meta.description);
		const badges = [...(row?.querySelectorAll('[data-slot="badge"]') ?? [])];
		expect(badges.map((badge) => badge.textContent)).toEqual([...meta.props]);
	}

	// The id is stable: closing and reopening shows the same persisted id.
	await press("Escape", dialog);
	await until(() => openDialogs().length === 0, "inspector closed");
	expect(document.activeElement === button("See what we send")).toBe(true);
	const reopened = await openInspector();
	expect(dialogDescription(reopened)).toContain(`${installId}.`);
	expect(localStorage.getItem(INSTALL_KEY)).toBe(installId);
});

test("events sent while open appear through Refresh and the live poll, newest first with their time and props; opted-out events never appear", async () => {
	await mount();
	await openInspector();
	expect(text()).toContain("Egress log (0)");
	expect(text()).toContain("Nothing sent yet.");
	expect(isDisabled(button("Clear log"))).toBe(true);

	track({ event: "agent_installed", agent_id: "agent-alpha" });
	const [first] = getEgressLog();
	expect(first?.event).toBe("agent_installed");
	// Not shown until the inspector re-reads the log.
	expect(text()).toContain("Egress log (0)");
	await act(async () => button("Refresh").click());
	await flush(2);
	expect(text()).toContain("Egress log (1)");
	expect(egressRows()).toEqual([
		["agent_installed", formatDateTime(first?.at ?? 0), "agent_id=agent-alpha"],
	]);
	expect(isDisabled(button("Clear log"))).toBe(false);

	// An event an opted-out user triggers is never sent, so never logged.
	setAnalyticsEnabled(false);
	track({ event: "chat_started" });
	setAnalyticsEnabled(true);
	expect(getEgressLog()).toHaveLength(1);

	// Background work sends while the dialog stays open: the 2 s poll shows it
	// without a click.
	await act(async () => {
		await Bun.sleep(10);
	});
	track({ event: "model_install_completed", model_id: "llama-3", ok: false });
	await until(() => text().includes("Egress log (2)"), "live poll", 3000);
	const rows = egressRows();
	expect(rows.map(([event]) => event)).toEqual([
		"model_install_completed",
		"agent_installed",
	]);
	expect(rows[0]?.[2]).toBe("model_id=llama-3, ok=false");
	expect(text()).not.toContain("chat_started (no props)");
});

test("Clear log empties only the egress record, survives a remount, and disables itself", async () => {
	track({ event: "onboarding_completed" });
	track({ event: "feature_enabled", section: "meetings" });
	await mount();
	await openInspector();
	const installBefore = localStorage.getItem(INSTALL_KEY);
	expect(installBefore).not.toBeNull();
	expect(text()).toContain("Egress log (2)");
	expect(egressRows().map((row) => row[2])).toEqual([
		"section=meetings",
		"(no props)",
	]);

	await act(async () => button("Clear log").click());
	await flush(2);
	expect(text()).toContain("Egress log (0)");
	expect(text()).toContain("Nothing sent yet.");
	expect(localStorage.getItem(EGRESS_KEY)).toBeNull();
	expect(isDisabled(button("Clear log"))).toBe(true);
	// Unrelated records are conserved.
	expect(localStorage.getItem(UNRELATED_KEY)).toBe("true");
	expect(localStorage.getItem(INSTALL_KEY)).toBe(installBefore);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("true");

	await unmount();
	await mount();
	await openInspector();
	expect(text()).toContain("Egress log (0)");
	expect(getEgressLog()).toEqual([]);
});

test("the live poll runs only while the dialog is open and its timer is cleared on close and on unmount", async () => {
	const started = spyOn(globalThis, "setInterval");
	const cleared = spyOn(globalThis, "clearInterval");
	/** Ids of the inspector's 2 s polls, in start order. */
	const polls = () =>
		started.mock.calls.flatMap(([, delay], index) =>
			delay === 2000 ? [started.mock.results[index]?.value] : []
		);
	const clearedIds = (): unknown[] =>
		cleared.mock.calls.map(([id]): unknown => id);
	try {
		await mount();
		await act(async () => {
			await Bun.sleep(50);
		});
		expect(polls()).toEqual([]);

		const dialog = await openInspector();
		expect(polls()).toHaveLength(1);
		const [firstPoll] = polls();
		// The running poll is what refreshes the open dialog.
		track({ event: "error_shown", code: "E_POLL" });
		await until(() => text().includes("code=E_POLL"), "poll refresh", 3000);
		expect(clearedIds()).not.toContain(firstPoll);

		await press("Escape", dialog);
		await until(() => openDialogs().length === 0, "inspector closed");
		expect(clearedIds()).toContain(firstPoll);
		expect(polls()).toHaveLength(1);

		await openInspector();
		expect(polls()).toHaveLength(2);
		const [, secondPoll] = polls();
		expect(clearedIds()).not.toContain(secondPoll);
		await unmount();
		expect(clearedIds()).toContain(secondPoll);
		expect(maybeButton("Refresh") === null).toBe(true);
	} finally {
		started.mockRestore();
		cleared.mockRestore();
	}
});
