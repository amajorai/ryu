import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { sileo } from "sileo";
import { z } from "zod";
import type { Node } from "@/src/store/useNodeStore.ts";

// The REAL Privacy tab (and its real AnalyticsInspector, sub-page navigation,
// consent gates and preference SDK) against a loopback Bun "Core" that keeps
// preferences and the self-healing config durably per test. Only that origin
// is reachable; the Tauri bridge is an in-process recorder for open_external.
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let ownedOrigin: string | null = null;
const rejectedEgress: string[] = [];
let inFlight = 0;
const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new NativeRequest(input, init).url);
		if (url.origin !== ownedOrigin) {
			rejectedEgress.push(url.href);
			throw new Error("Privacy coverage refuses unowned HTTP egress");
		}
		inFlight++;
		try {
			return await nativeFetch(input, init);
		} finally {
			inFlight--;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;

const ipc: Array<{ args: unknown; command: string }> = [];
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: unknown) => {
		ipc.push({ args, command });
		return Promise.resolve(null);
	},
	transformCallback: () => 0,
});

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { PrivacySettings } = await import("./PrivacySettings.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { isAnalyticsEnabled, ANALYTICS_EVENT_NAMES, getInstallId } =
	await import("@/src/lib/analytics.ts");
const { isCrashReportingEnabled } = await import("@/src/lib/crash.ts");
const { FRONTEND_URL } = await import("@/lib/auth-client.ts");
const { requestSettingReveal, clearSettingReveal } = await import(
	"@/src/lib/settings-focus.ts"
);
const { SETTINGS_ENTRIES } = await import("@/src/lib/settings-index.ts");
const {
	blur,
	button,
	choose,
	click,
	comboIn,
	fill,
	flush,
	isDisabled,
	isOn,
	maybeButton,
	maybeRow,
	row,
	settle,
	shownValue,
	switchIn,
	toasts,
} = await import("./privacy-security.test-support.ts");

// ── Native Core fixture ────────────────────────────────────────────────────
const TOKEN = "privacy-node-token";
const USER_JWT = "privacy-user-jwt";
const DEFAULT_PREFS = {
	"product-analytics-enabled": "true",
	"community-stats-enabled": "true",
	"profile-activity-enabled": "true",
	"crash-reports-enabled": "true",
	"diagnostics-export-enabled": "false",
	"diagnostics-otlp-endpoint": "",
	"support-access-local-enabled": "false",
	"support-access-local-expiry": "0",
};
const DEFAULT_HEALING = {
	auto_decide: false,
	cooldown_secs: 300,
	diagnose_effort: "low",
	diagnose_model: "fixture-model",
	enabled: true,
	max_attempts: 2,
};
const preferenceBody = z.object({ value: z.string() });
const healingPatch = z
	.object({ auto_decide: z.boolean(), enabled: z.boolean() })
	.partial()
	.strict();

interface Call {
	body: unknown;
	key: string;
	method: string;
}
interface Armed {
	hold?: Promise<void>;
	key: string;
	method: string;
	status: number;
}
let prefs = new Map<string, string>();
let healing = { ...DEFAULT_HEALING };
let calls: Call[] = [];
let armed: Armed[] = [];
let unexpected: string[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const pref = /^\/api\/preferences\/([^/]+)$/.exec(url.pathname);
		const isHealing = url.pathname === "/api/healing/config";
		if (!(pref || isHealing)) {
			unexpected.push(`${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "Unknown route" }, { status: 404 });
		}
		if (
			request.headers.get("authorization") !== `Bearer ${TOKEN}` ||
			request.headers.get("x-ryu-user-jwt") !== USER_JWT
		) {
			unexpected.push(`unauthenticated ${request.method} ${url.pathname}`);
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		const key = pref ? decodeURIComponent(pref[1]!) : "healing";
		const body = request.method === "GET" ? null : await request.json();
		calls.push({ body, key, method: request.method });
		const trap = armed.find(
			(a) => a.key === key && a.method === request.method
		);
		if (trap) {
			armed = armed.filter((a) => a !== trap);
			await trap.hold;
			if (trap.status !== 200) {
				return NativeResponse.json(
					{ error: "Fixture refusal" },
					{ status: trap.status }
				);
			}
		}
		if (isHealing) {
			if (request.method === "GET") {
				return NativeResponse.json(healing);
			}
			const patch = healingPatch.safeParse(body);
			if (request.method !== "POST" || !patch.success) {
				unexpected.push(`bad healing ${request.method}`);
				return NativeResponse.json({ error: "Bad patch" }, { status: 400 });
			}
			healing = { ...healing, ...patch.data };
			return NativeResponse.json(healing);
		}
		if (request.method === "GET") {
			return NativeResponse.json({ key, value: prefs.get(key) ?? null });
		}
		const parsed = preferenceBody.safeParse(body);
		if (request.method !== "PUT" || !parsed.success) {
			unexpected.push(`bad preference ${request.method} ${key}`);
			return NativeResponse.json({ error: "Bad body" }, { status: 400 });
		}
		prefs.set(key, parsed.data.value);
		return NativeResponse.json({ ok: true });
	},
});
ownedOrigin = server.url.origin;

const node: Node = {
	name: "privacy-node",
	url: server.url.origin,
	token: TOKEN,
	userJwt: USER_JWT,
};
const savedNodeState = useNodeStore.getState();
let root: Root | null = null;

function arm(method: string, key: string, status: number) {
	let release: () => void = () => undefined;
	const hold = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	armed.push({ hold, key, method, status });
	return release;
}
function refuse(method: string, key: string, status = 503) {
	armed.push({ key, method, status });
}
function writes(key?: string) {
	return calls
		.filter((c) => c.method !== "GET" && (key ? c.key === key : true))
		.map((c) => c.body);
}
function reads(key: string) {
	return calls.filter((c) => c.method === "GET" && c.key === key).length;
}

async function mount(page?: string) {
	const expiryReads = reads("support-access-local-expiry");
	const healingReads = reads("healing");
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<>
				<PrivacySettings />
				<Toaster />
			</>
		)
	);
	await settle(
		() =>
			reads("support-access-local-expiry") > expiryReads &&
			reads("healing") > healingReads,
		"privacy preference reads"
	);
	await flush();
	if (page) {
		await openPage(page);
	}
}
async function unmount() {
	await settle(() => inFlight === 0, "privacy HTTP drained");
	if (root) {
		const current = root;
		await act(async () => current.unmount());
		root = null;
	}
	document.body.replaceChildren();
}
async function remount(page?: string) {
	await unmount();
	await mount(page);
}
const PAGE_TITLES = new Set([
	"Device permissions",
	"Usage & crash data",
	"Diagnostics & support",
	"Self-healing",
	"Custom app security",
]);
/** The open sub-page's heading, or null on the Privacy index. */
function pageHeading(): string | null {
	return (
		[...document.querySelectorAll("h3")]
			.map((heading) => heading.textContent ?? "")
			.find((text) => PAGE_TITLES.has(text)) ?? null
	);
}
async function openPage(title: string) {
	await click(button(title));
	await settle(() => pageHeading() === title, `sub-page ${title}`);
}
async function toggle(title: string) {
	await settle(() => !isDisabled(switchIn(title)), `${title} enabled`);
	await click(switchIn(title));
}

beforeEach(() => {
	sileo.clear();
	prefs = new Map(Object.entries(DEFAULT_PREFS));
	healing = { ...DEFAULT_HEALING };
	calls = [];
	armed = [];
	unexpected = [];
	ipc.length = 0;
	localStorage.clear();
	useNodeStore.setState({
		nodes: [node],
		localNodes: [],
		defaultNode: node.name,
		autoSelect: false,
	});
});
afterEach(async () => {
	clearSettingReveal();
	await unmount();
	sileo.clear();
	useNodeStore.setState(savedNodeState);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must keep to the owned Core contract.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must refuse foreign egress.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("What leaves this device lists every page, opens one, returns with Privacy, and a search reveal opens the page holding the row", async () => {
	await mount();
	const indexTitles = [
		"Device permissions",
		"Usage & crash data",
		"Diagnostics & support",
		"Self-healing",
		"Custom app security",
	];
	expect(document.body.textContent).toContain("What leaves this device");
	for (const title of indexTitles) {
		expect(button(title).getAttribute("type")).toBe("button");
	}
	expect(maybeRow("Access duration")).toBeNull();
	await openPage("Self-healing");
	expect(document.body.textContent).toContain(
		"Let Ryu diagnose a failed run and propose — or apply — a fix."
	);
	expect(maybeButton("Diagnostics & support")).toBeNull();
	expect(document.body.textContent).not.toContain("What leaves this device");
	expect(maybeRow("Diagnose failed runs")).not.toBeNull();
	await click(button("Privacy"));
	await settle(
		() => maybeButton("Diagnostics & support") !== null,
		"back to the Privacy index"
	);
	expect(pageHeading()).toBe(null);
	expect(document.body.textContent).toContain("What leaves this device");
	await unmount();

	const entry = SETTINGS_ENTRIES.find(
		(candidate) =>
			candidate.id === "gw.privacy.support-access-local.access-duration"
	);
	if (!entry) {
		throw new Error("Missing indexed Access duration entry");
	}
	requestSettingReveal(entry);
	await mount();
	await settle(
		() => maybeRow("Access duration") !== null,
		"search reveal opened Diagnostics & support"
	);
	expect(pageHeading()).toBe("Diagnostics & support");
});

test("community stats switch saves the exact preference, survives a remount, rolls back a refused write, and conserves other consent", async () => {
	await mount("Usage & crash data");
	const title = "Share anonymous community stats";
	expect(isOn(switchIn(title))).toBe(true);
	await toggle(title);
	await settle(() => prefs.get("community-stats-enabled") === "false", "save");
	expect(writes()).toEqual([{ value: "false" }]);
	expect(isOn(switchIn(title))).toBe(false);
	expect(prefs.get("product-analytics-enabled")).toBe("true");
	expect(prefs.get("crash-reports-enabled")).toBe("true");

	await remount("Usage & crash data");
	expect(isOn(switchIn(title))).toBe(false);

	refuse("PUT", "community-stats-enabled");
	await toggle(title);
	await settle(
		() =>
			document.body.textContent?.includes(
				"Couldn't save your community-stats choice"
			) === true,
		"refusal toast"
	);
	await settle(() => !isOn(switchIn(title)), "rollback");
	expect(prefs.get("community-stats-enabled")).toBe("false");

	await toggle(title);
	await settle(() => prefs.get("community-stats-enabled") === "true", "retry");
	expect(writes("community-stats-enabled")).toEqual([
		{ value: "false" },
		{ value: "true" },
		{ value: "true" },
	]);
	expect(isOn(switchIn(title))).toBe(true);
	expect(writes("product-analytics-enabled")).toEqual([]);
	expect(writes("crash-reports-enabled")).toEqual([]);
});

test("profile activity switch saves the exact preference, survives a remount, rolls back a refused write, and conserves other consent", async () => {
	await mount("Usage & crash data");
	const title = "Sync activity on this device to your profile";
	expect(document.body.textContent).toContain(
		"daily usage totals (tokens, requests, sessions, and requests per model)"
	);
	expect(document.body.textContent).toContain(
		"These totals never earn points."
	);
	expect(document.body.textContent).toContain(
		"Never prompts, conversations, files, or agent content."
	);
	expect(document.body.textContent).toContain(
		"Chats and agent runs on this device, including scheduled ones"
	);
	expect(document.body.textContent).toContain("Linked to your account");
	expect(isOn(switchIn(title))).toBe(true);
	await toggle(title);
	await settle(() => prefs.get("profile-activity-enabled") === "false", "save");
	expect(writes()).toEqual([{ value: "false" }]);
	expect(isOn(switchIn(title))).toBe(false);
	expect(prefs.get("community-stats-enabled")).toBe("true");
	expect(prefs.get("product-analytics-enabled")).toBe("true");

	await remount("Usage & crash data");
	expect(isOn(switchIn(title))).toBe(false);

	refuse("PUT", "profile-activity-enabled");
	await toggle(title);
	await settle(
		() =>
			document.body.textContent?.includes(
				"Couldn't save your profile-activity choice"
			) === true,
		"refusal toast"
	);
	await settle(() => !isOn(switchIn(title)), "rollback");
	expect(prefs.get("profile-activity-enabled")).toBe("false");
	expect(writes("community-stats-enabled")).toEqual([]);
});

test("crash report switch closes the live crash gate before Core answers, reopens it only after the ACK, and restores it when Core refuses", async () => {
	await mount("Usage & crash data");
	const title = "Send crash and error reports";
	expect(isOn(switchIn(title))).toBe(true);
	expect(isCrashReportingEnabled()).toBe(true);

	const releaseOff = arm("PUT", "crash-reports-enabled", 200);
	await toggle(title);
	await settle(() => writes("crash-reports-enabled").length === 1, "held off");
	expect(isCrashReportingEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:crash-reports-enabled")).toBe("false");
	expect(isDisabled(switchIn(title))).toBe(true);
	releaseOff();
	await settle(() => prefs.get("crash-reports-enabled") === "false", "off ACK");
	await settle(() => !isDisabled(switchIn(title)), "switch idle");

	const releaseOn = arm("PUT", "crash-reports-enabled", 200);
	await toggle(title);
	await settle(() => writes("crash-reports-enabled").length === 2, "held on");
	expect(isOn(switchIn(title))).toBe(true);
	expect(isCrashReportingEnabled()).toBe(false);
	releaseOn();
	await settle(() => isCrashReportingEnabled(), "gate opened after ACK");
	expect(prefs.get("crash-reports-enabled")).toBe("true");
	expect(localStorage.getItem("ryu:crash-reports-enabled")).toBe("true");

	refuse("PUT", "crash-reports-enabled", 403);
	await toggle(title);
	await settle(
		() =>
			document.body.textContent?.includes(
				"Couldn't save your crash-report choice"
			) === true,
		"refusal toast"
	);
	await settle(() => isOn(switchIn(title)), "rollback");
	expect(isCrashReportingEnabled()).toBe(true);
	expect(prefs.get("crash-reports-enabled")).toBe("true");
	expect(writes("crash-reports-enabled")).toEqual([
		{ value: "false" },
		{ value: "true" },
		{ value: "false" },
	]);
	expect(prefs.get("product-analytics-enabled")).toBe("true");
	expect(isAnalyticsEnabled()).toBe(true);
});

test("OTLP export switch and endpoint field write exact trimmed values only on commit and reload from Core", async () => {
	await mount("Diagnostics & support");
	const exportTitle = "Export local diagnostics over OTLP";
	expect(isOn(switchIn(exportTitle))).toBe(false);
	await toggle(exportTitle);
	await settle(
		() => prefs.get("diagnostics-export-enabled") === "true",
		"export on"
	);

	const endpoint = document.querySelector<HTMLInputElement>(
		'input[aria-label="OTLP endpoint"]'
	);
	if (!endpoint) {
		throw new Error("Missing OTLP endpoint input");
	}
	expect(endpoint.placeholder).toBe("https://api.axiom.co");
	await fill(endpoint, "  https://collector.example.test:4318  ");
	await flush();
	expect(writes("diagnostics-otlp-endpoint")).toEqual([]);
	await blur(endpoint);
	await settle(
		() =>
			prefs.get("diagnostics-otlp-endpoint") ===
			"https://collector.example.test:4318",
		"endpoint commit"
	);
	expect(writes("diagnostics-otlp-endpoint")).toEqual([
		{ value: "https://collector.example.test:4318" },
	]);

	await remount("Diagnostics & support");
	expect(isOn(switchIn(exportTitle))).toBe(true);
	const reloaded = document.querySelector<HTMLInputElement>(
		'input[aria-label="OTLP endpoint"]'
	);
	expect(reloaded?.value).toBe("https://collector.example.test:4318");

	refuse("PUT", "diagnostics-otlp-endpoint");
	await fill(reloaded!, "http://127.0.0.1:4318");
	await blur(reloaded!);
	await settle(
		() =>
			document.body.textContent?.includes(
				"Couldn't save the diagnostics endpoint"
			) === true,
		"endpoint refusal toast"
	);
	expect(prefs.get("diagnostics-otlp-endpoint")).toBe(
		"https://collector.example.test:4318"
	);
	expect(prefs.get("diagnostics-export-enabled")).toBe("true");
	expect(prefs.get("support-access-local-enabled")).toBe("false");
});

test("Content mode starts as metadata only, offers exactly two choices, writes the exact value, warns only while full content is selected, reloads from Core, and rolls back a refused write", async () => {
	const key = "diagnostics-otlp-content-mode";
	const warning =
		"Your prompts, model responses, and tool data will leave this device";
	const rowText = () => row("Content mode").textContent ?? "";
	await mount("Diagnostics & support");
	// Core never stored a mode on this node, so the control shows the default.
	expect(prefs.has(key)).toBe(false);
	expect(shownValue(comboIn("Content mode"))).toContain("Metadata only");
	expect(rowText()).not.toContain(warning);

	const offered = await choose(comboIn("Content mode"), "Full content");
	expect(offered).toEqual(["Metadata only", "Full content"]);
	await settle(() => prefs.get(key) === "content", "content mode stored");
	expect(writes(key)).toEqual([{ value: "content" }]);
	expect(shownValue(comboIn("Content mode"))).toContain("Full content");
	expect(rowText()).toContain(warning);
	// Content mode is its own consent: it never turns export or support access on.
	expect(prefs.get("diagnostics-export-enabled")).toBe("false");
	expect(prefs.get("support-access-local-enabled")).toBe("false");

	await remount("Diagnostics & support");
	expect(shownValue(comboIn("Content mode"))).toContain("Full content");
	expect(rowText()).toContain(warning);

	refuse("PUT", key);
	await choose(comboIn("Content mode"), "Metadata only");
	await settle(
		() => toasts().includes("Couldn't save the diagnostics content mode"),
		"content mode refusal toast"
	);
	expect(prefs.get(key)).toBe("content");
	expect(shownValue(comboIn("Content mode"))).toContain("Full content");
	expect(rowText()).toContain(warning);

	await choose(comboIn("Content mode"), "Metadata only");
	await settle(
		() => prefs.get(key) === "metadata_only",
		"metadata only stored"
	);
	expect(shownValue(comboIn("Content mode"))).toContain("Metadata only");
	expect(rowText()).not.toContain(warning);
	expect(writes(key)).toEqual([
		{ value: "content" },
		{ value: "metadata_only" },
		{ value: "metadata_only" },
	]);
});

test("Destination picks an exporter preset, shows its fields, saves secret references, and refuses a pasted key", async () => {
	await mount("Diagnostics & support");
	const destination = comboIn("Destination");
	expect(shownValue(destination)).toContain("Any OTLP endpoint");
	await choose(destination, "Langfuse");
	await settle(
		() => prefs.get("diagnostics-otlp-preset") === "langfuse",
		"preset commit"
	);
	const field = (label: string) => {
		const input = document.querySelector<HTMLInputElement>(
			`input[aria-label="${label}"]`
		);
		if (!input) {
			throw new Error(`Missing ${label} input`);
		}
		return input;
	};
	const apiKey = field("API key reference");
	field("Public key reference");
	field("Region or site");
	expect(document.querySelector('input[aria-label="Project"]')).toBeNull();

	await fill(apiKey, " env:LANGFUSE_SECRET_KEY ");
	await blur(apiKey);
	await settle(
		() =>
			prefs.get("diagnostics-otlp-api-key-ref") === "env:LANGFUSE_SECRET_KEY",
		"reference commit"
	);

	await fill(apiKey, "sk-lf-pasted-secret");
	await blur(apiKey);
	await settle(
		() =>
			document.body.textContent?.includes(
				"Use a secret reference, not the key itself"
			) === true,
		"literal key refusal"
	);
	expect(writes("diagnostics-otlp-api-key-ref")).toEqual([
		{ value: "env:LANGFUSE_SECRET_KEY" },
	]);

	await remount("Diagnostics & support");
	expect(shownValue(comboIn("Destination"))).toContain("Langfuse");
	expect(field("API key reference").value).toBe("env:LANGFUSE_SECRET_KEY");
});

test("Access duration sets the grant's finite expiry, locks while access is active, and unlocks after access ends", async () => {
	await mount("Diagnostics & support");
	const duration = comboIn("Access duration");
	expect(shownValue(duration)).toContain("1 hour");
	await choose(duration, "8 hours");
	expect(shownValue(comboIn("Access duration"))).toContain("8 hours");
	expect(writes()).toEqual([]);

	const before = Date.now();
	await toggle("Grant local support access");
	await settle(
		() => prefs.get("support-access-local-enabled") === "true",
		"grant"
	);
	const after = Date.now();
	const expiry = Number(prefs.get("support-access-local-expiry"));
	expect(expiry).toBeGreaterThanOrEqual(before + 8 * 3_600_000);
	expect(expiry).toBeLessThanOrEqual(after + 8 * 3_600_000);
	expect(writes()).toEqual([{ value: String(expiry) }, { value: "true" }]);
	expect(document.body.textContent).toContain("Active until");
	await settle(() => isDisabled(comboIn("Access duration")), "duration lock");

	await remount("Diagnostics & support");
	expect(isOn(switchIn("Grant local support access"))).toBe(true);
	expect(isDisabled(comboIn("Access duration"))).toBe(true);

	await toggle("Grant local support access");
	await settle(
		() => prefs.get("support-access-local-enabled") === "false",
		"end access"
	);
	expect(prefs.get("support-access-local-expiry")).toBe(String(expiry));
	await settle(
		() => !isDisabled(comboIn("Access duration")),
		"duration unlock"
	);
	await choose(comboIn("Access duration"), "24 hours");
	const regrantBefore = Date.now();
	await toggle("Grant local support access");
	await settle(
		() => prefs.get("support-access-local-enabled") === "true",
		"regrant"
	);
	expect(
		Number(prefs.get("support-access-local-expiry"))
	).toBeGreaterThanOrEqual(regrantBefore + 24 * 3_600_000);
});

test("self-healing switches post exact patches, gate auto-fix on diagnosis, roll back refusals, and recover a failed load", async () => {
	refuse("GET", "healing");
	await mount("Self-healing");
	await settle(
		() =>
			document
				.querySelector('[role="alert"]')
				?.textContent?.includes("Couldn't load self-healing choices") === true,
		"healing load error"
	);
	expect(isDisabled(switchIn("Diagnose failed runs"))).toBe(true);
	await click(switchIn("Diagnose failed runs"));
	expect(writes("healing")).toEqual([]);
	await click(button("Retry privacy settings"));
	await settle(
		() => !isDisabled(switchIn("Diagnose failed runs")),
		"healing reload"
	);
	expect(document.querySelector('[role="alert"]')).toBeNull();

	expect(isOn(switchIn("Diagnose failed runs"))).toBe(true);
	expect(isOn(switchIn("Auto-fix without asking"))).toBe(false);
	await toggle("Auto-fix without asking");
	await settle(() => healing.auto_decide, "auto-fix saved");
	expect(writes("healing")).toEqual([{ auto_decide: true }]);

	refuse("POST", "healing", 500);
	await toggle("Diagnose failed runs");
	await settle(
		() =>
			document.body.textContent?.includes(
				"Couldn't save your self-healing choice"
			) === true,
		"healing refusal toast"
	);
	await settle(() => isOn(switchIn("Diagnose failed runs")), "rollback");
	expect(healing.enabled).toBe(true);

	await toggle("Diagnose failed runs");
	await settle(() => !healing.enabled, "diagnosis off");
	await settle(
		() => isDisabled(switchIn("Auto-fix without asking")),
		"auto-fix gated"
	);
	expect(writes("healing")).toEqual([
		{ auto_decide: true },
		{ enabled: false },
		{ enabled: false },
	]);
	expect(healing).toEqual({
		...DEFAULT_HEALING,
		auto_decide: true,
		enabled: false,
	});

	await remount("Self-healing");
	expect(isOn(switchIn("Diagnose failed runs"))).toBe(false);
	expect(isOn(switchIn("Auto-fix without asking"))).toBe(true);
	expect(isDisabled(switchIn("Auto-fix without asking"))).toBe(true);
	expect(writes().length).toBe(3);
});

test("What we send opens the analytics inspector with the full catalog and the local egress log, and Clear log empties it", async () => {
	localStorage.setItem(
		"ryu:analytics-egress-log",
		JSON.stringify([
			{ at: Date.UTC(2026, 9, 1), event: "chat_started", props: {} },
			{
				at: Date.UTC(2026, 9, 2),
				event: "model_install_completed",
				props: { model_id: "fixture-model", ok: true },
			},
		])
	);
	await mount("Usage & crash data");
	expect(document.body.textContent).toContain(
		"See the full list of events the app can send"
	);
	await click(button("See what we send", row("What we send")));
	await settle(
		() =>
			document.body.textContent?.includes("What product analytics sends") ===
			true,
		"inspector open"
	);
	const text = () => document.body.textContent ?? "";
	expect(text()).toContain(`Event catalog (${ANALYTICS_EVENT_NAMES.length})`);
	for (const name of ANALYTICS_EVENT_NAMES) {
		expect(text()).toContain(name);
	}
	expect(text()).toContain(getInstallId());
	expect(text()).toContain("Egress log (2)");
	const newest = text().indexOf("model_id=fixture-model, ok=true");
	const oldest = text().indexOf("(no props)");
	expect(newest).toBeGreaterThan(-1);
	expect(oldest).toBeGreaterThan(newest);

	await click(button("Clear log"));
	await settle(() => text().includes("Egress log (0)"), "log cleared");
	expect(text()).toContain("Nothing sent yet.");
	expect(localStorage.getItem("ryu:analytics-egress-log")).toBeNull();
	expect(isDisabled(button("Clear log"))).toBe(true);
	expect(writes()).toEqual([]);
});

test("first-run disclosure Got it persists across a remount and the privacy page link opens the public transparency page", async () => {
	await mount();
	expect(document.body.textContent).toContain("How Ryu handles your data");
	const links = [...document.querySelectorAll("button")].filter(
		(candidate) => candidate.textContent === "our privacy & data page"
	);
	expect(links).toHaveLength(2);
	await click(links[0]!);
	await settle(() => ipc.length === 1, "open_external");
	expect(ipc).toEqual([
		{
			command: "open_external",
			args: { url: `${FRONTEND_URL}/docs/surfaces/desktop/transparency` },
		},
	]);
	await click(button("Got it"));
	expect(localStorage.getItem("ryu:privacy-disclosure-ack")).toBe("true");
	expect(document.body.textContent).not.toContain("How Ryu handles your data");
	await remount();
	expect(document.body.textContent).not.toContain("How Ryu handles your data");
	expect(maybeButton("Got it")).toBeNull();
	expect(writes()).toEqual([]);
});
