import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";

// The REAL Appearance tab, mounted in happy-dom next to the REAL consumers its
// preferences drive (the composer/sidebar UsageBar, the workspace RichPatchDiff,
// the titlebar's seasonal particle layer). Core is a loopback Bun server reached
// through the production SDK, so theme-preference publication and the usage
// meter's data are real HTTP exchanges. Nothing under test is substituted.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const ownsDomRegistration = globalThis.document === undefined;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDomRegistration) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Halloween is the running season on this date, so "Automatic" has a season.
setSystemTime(new Date("2026-10-11T12:00:00.000Z"));

const { ThemeProvider } = await import("next-themes");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { useProductModeStore } = await import("@/src/lib/product-mode.ts");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { UsageBar } = await import(
	"@/components/agent-elements/input/usage-bar.tsx"
);
const { RichPatchDiff } = await import(
	"@/src/components/diffs/RichPatchDiff.tsx"
);
const { SeasonalParticles } = await import(
	"@/src/components/layout/SeasonalEffects.tsx"
);
const { useActiveSeason, previewSeasonalTheme } = await import(
	"@/src/hooks/useSeasonalEffects.ts"
);
const { useUsageBarPrefs, resetUsageBarPrefs } = await import(
	"@/src/hooks/useUsageBarPrefs.ts"
);
const { useChatPickerPlacement, setChatPickerPlacement } = await import(
	"@/src/hooks/useChatPickerPlacement.ts"
);
const { useDiffViewPrefs, diffViewPrefsToOptions } = await import(
	"@/src/hooks/useDiffViewPrefs.ts"
);
const { useNotificationLayout } = await import(
	"@/src/lib/notification-layout.ts"
);
const { initTheme } = await import("@/src/hooks/useThemePreset.ts");
const { useFileTreePrefs, fileTreePrefsToOptions } = await import(
	"@/src/hooks/useFileTreePrefs.ts"
);
const { FileTree, useFileTree } = await import("@pierre/trees/react");
const { ChatDisplayPrefs } = await import(
	"@/src/components/chat/ChatDisplayPrefsProvider.tsx"
);
const { useChatDisplayPrefs } = await import(
	"@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx"
);
const { requestSettingReveal, clearSettingReveal } = await import(
	"@/src/lib/settings-focus.ts"
);
const { SETTINGS_ENTRIES } = await import("@/src/lib/settings-index.ts");
const { AppearanceTab } = await import("./AppearanceTab.tsx");

// ── Native Core fixture ────────────────────────────────────────────────────
interface Exchange {
	authorization: string | null;
	body: string;
	method: string;
	path: string;
}
const exchanges: Exchange[] = [];
const undeclared: string[] = [];
const CORE_TOKEN = "appearance-coverage-token";
const USAGE_AGENT = "claude-code";
const usageWire = {
	agent_id: USAGE_AGENT,
	available: true,
	engine: "claude",
	plan: "Max",
	windows: [
		{
			label: "Session",
			resets_at: null,
			used_percent: 40,
			window_seconds: 18_000,
		},
		{
			label: "Weekly",
			resets_at: null,
			used_percent: 75,
			window_seconds: 604_800,
		},
	],
	meters: [],
};
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = request.method === "GET" ? "" : await request.text();
		exchanges.push({
			authorization: request.headers.get("authorization"),
			body,
			method: request.method,
			path: url.pathname,
		});
		if (url.pathname === "/api/plugins/contributions") {
			return NativeResponse.json({});
		}
		if (url.pathname === "/api/preferences/theme" && request.method === "PUT") {
			return NativeResponse.json({ ok: true });
		}
		// `useAgentUsage` first lists Core's subscription providers (without
		// usage) to learn whether the agent id is a provider; this one is not,
		// so it settles on the agent usage route below.
		if (
			url.pathname === "/api/usage/subscriptions" &&
			url.searchParams.get("usage") === "none" &&
			request.method === "GET"
		) {
			return NativeResponse.json({
				generatedAt: "2026-10-01T00:00:00.000Z",
				providers: [],
				version: 1,
			});
		}
		if (
			url.pathname === `/api/agents/${USAGE_AGENT}/usage` &&
			request.method === "GET"
		) {
			return NativeResponse.json(usageWire);
		}
		undeclared.push(`${request.method} ${url.pathname}`);
		return new NativeResponse("undeclared route", { status: 404 });
	},
});
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "appearance-coverage",
	nodes: [
		{
			name: "appearance-coverage",
			url: server.url.origin,
			token: CORE_TOKEN,
		},
	],
});

const themePrefsSchema = z
	.object({
		codeFont: z.string().optional(),
		headingFont: z.string().optional(),
		uiFont: z.string().optional(),
	})
	.passthrough();
/** Every theme-preference document Core acknowledged, parsed. */
function publishedThemePrefs() {
	return exchanges
		.filter((e) => e.method === "PUT" && e.path === "/api/preferences/theme")
		.map((e) => ({
			authorization: e.authorization,
			prefs: themePrefsSchema.parse(
				JSON.parse(
					z.object({ value: z.string() }).parse(JSON.parse(e.body)).value
				)
			),
		}));
}

// ── Consumers driven by the preferences ────────────────────────────────────
// Each mirrors the shipping call site named in its comment: the same hook, the
// same branch, the same real child component.

/** AppSidebar: `notificationLayout === "split"` splits announcements out. */
function NotificationLayoutConsumer() {
	const layout = useNotificationLayout();
	return <output data-consumer="notification-layout">{layout}</output>;
}

/** TitleBar: `useActiveSeason()` gates the SeasonalParticles layer. */
function SeasonConsumer() {
	const season = useActiveSeason();
	return (
		<div data-consumer="season" data-season={season?.id ?? "none"}>
			{season ? (
				<SeasonalParticles count={2} emoji={season.emoji} wind={false} />
			) : null}
		</div>
	);
}

/** ChatPage: `chatPickerPlacement === "tab-bar"` moves the picker. */
function ChatPickerConsumer() {
	const [placement] = useChatPickerPlacement();
	return (
		<div data-consumer="chat-picker">
			{placement === "tab-bar" ? (
				<span data-testid="chat-model-agent-picker-tab-bar" />
			) : (
				<span data-testid="chat-model-agent-picker-composer" />
			)}
		</div>
	);
}

/** Composer (full meter) and AppSidebar's agent row (its own `sidebar` gate). */
function UsageConsumers() {
	const prefs = useUsageBarPrefs();
	return (
		<>
			<div data-consumer="usage-composer">
				<UsageBar agentId={USAGE_AGENT} />
			</div>
			<div data-consumer="usage-sidebar">
				{prefs.sidebar ? (
					<UsageBar agentId={USAGE_AGENT} visible={prefs.sidebar} />
				) : null}
			</div>
		</>
	);
}

const OLD_LINES = Array.from(
	{ length: 40 },
	(_, i) => `const line${i + 1} = ${i + 1};`
);
const NEW_LINES = OLD_LINES.map((line, i) =>
	i === 2 || i === 36 ? line.replace(" = ", " = 100 + ") : line
);
const OLD_FILE = { name: "values.ts", contents: `${OLD_LINES.join("\n")}\n` };
const NEW_FILE = { name: "values.ts", contents: `${NEW_LINES.join("\n")}\n` };

/** WorkspacePanels' PatchDiffPanel: prefs → options → RichPatchDiff. */
function DiffConsumer() {
	const prefs = useDiffViewPrefs();
	const options = useMemo(() => diffViewPrefsToOptions(prefs), [prefs]);
	return (
		<div data-consumer="diff">
			<RichPatchDiff
				newFile={NEW_FILE}
				oldFile={OLD_FILE}
				options={options}
				patch=""
			/>
		</div>
	);
}

const WORKSPACE_PATHS = ["packages/app/src/main.ts", "README.md"];

/** WorkspacePanels' file tree: prefs → options → useFileTree, keyed remount. */
function WorkspaceTree({
	options,
}: {
	options: ReturnType<typeof fileTreePrefsToOptions>;
}) {
	const { model } = useFileTree({ ...options, paths: WORKSPACE_PATHS });
	return <FileTree model={model} />;
}

function WorkspaceTreeConsumer() {
	const prefs = useFileTreePrefs();
	const options = useMemo(() => fileTreePrefsToOptions(prefs), [prefs]);
	return (
		<div data-consumer="workspace-tree">
			<WorkspaceTree key={JSON.stringify(options)} options={options} />
		</div>
	);
}

/** Layout: the desktop ChatDisplayPrefs host feeding the transcript context. */
function TranscriptPrefsReader() {
	const prefs = useChatDisplayPrefs();
	return <output data-consumer="transcript">{JSON.stringify(prefs)}</output>;
}

function TranscriptConsumer() {
	return (
		<ChatDisplayPrefs>
			<TranscriptPrefsReader />
		</ChatDisplayPrefs>
	);
}

type ConsumerName =
	| "chat-picker"
	| "diff"
	| "notification"
	| "season"
	| "transcript"
	| "usage"
	| "workspace-tree";
const CONSUMERS: Record<ConsumerName, () => ReactNode> = {
	"chat-picker": () => <ChatPickerConsumer key="chat-picker" />,
	diff: () => <DiffConsumer key="diff" />,
	transcript: () => <TranscriptConsumer key="transcript" />,
	"workspace-tree": () => <WorkspaceTreeConsumer key="workspace-tree" />,
	notification: () => <NotificationLayoutConsumer key="notification" />,
	season: () => <SeasonConsumer key="season" />,
	usage: () => <UsageConsumers key="usage" />,
};

// ── Mounting ───────────────────────────────────────────────────────────────
let root: Root | null = null;
let element: HTMLDivElement | null = null;
let consumerRoot: Root | null = null;
let consumerElement: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function providers(children: ReactNode) {
	return (
		<MemoryRouter>
			<QueryClientProvider client={queryClient!}>
				<AppSurfaceProvider surface="desktop">
					<ThemeProvider
						attribute="class"
						defaultTheme="light"
						enableSystem={false}
					>
						{children}
					</ThemeProvider>
				</AppSurfaceProvider>
			</QueryClientProvider>
		</MemoryRouter>
	);
}

// ── DOM helpers ────────────────────────────────────────────────────────────
function visibleText(node: Element | null = element) {
	if (!node) {
		return "";
	}
	const clone = node.cloneNode(true) as Element;
	for (const script of clone.querySelectorAll("script")) {
		script.remove();
	}
	return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function settle(predicate: () => boolean, label = predicate.toString()) {
	for (let count = 0; count < 200 && !predicate(); count += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	if (!predicate()) {
		throw new Error(`Condition not reached: ${label}`);
	}
}

async function flush(ms = 30) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function mountTab() {
	element = document.createElement("div");
	element.dataset.surface = "appearance";
	document.body.append(element);
	root = createRoot(element);
	await act(async () => root!.render(providers(<AppearanceTab />)));
	await settle(() => visibleText().includes("Customize"), "Customize index");
}

async function unmountTab() {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
}

async function mountConsumers(names: ConsumerName[]) {
	consumerElement = document.createElement("div");
	consumerElement.dataset.surface = "consumers";
	document.body.append(consumerElement);
	consumerRoot = createRoot(consumerElement);
	await act(async () =>
		consumerRoot!.render(providers(names.map((name) => CONSUMERS[name]())))
	);
}

async function unmountConsumers() {
	if (consumerRoot) {
		await act(async () => consumerRoot!.unmount());
	}
	consumerRoot = null;
	consumerElement?.remove();
	consumerElement = null;
}

function buttonNamed(name: string, scope: ParentNode = element!) {
	const matches = Array.from(
		scope.querySelectorAll<HTMLButtonElement>("button")
	).filter(
		(candidate) =>
			(candidate.getAttribute("aria-label") ??
				candidate.textContent?.replace(/\s+/g, " ").trim()) === name
	);
	if (matches.length !== 1) {
		throw new Error(`Expected one "${name}" button, found ${matches.length}`);
	}
	return matches[0]!;
}

/** The settings row whose title is exactly `title` (one per mounted page). */
function row(title: string) {
	const titles = Array.from(
		element!.querySelectorAll('[data-slot="item-title"]')
	).filter((candidate) => candidate.textContent?.trim() === title);
	if (titles.length !== 1) {
		throw new Error(`Expected one "${title}" row, found ${titles.length}`);
	}
	return titles[0]!.closest<HTMLElement>('[data-slot="item"]')!;
}

function hasRow(title: string) {
	return Array.from(element!.querySelectorAll('[data-slot="item-title"]')).some(
		(candidate) => candidate.textContent?.trim() === title
	);
}

function switchIn(title: string) {
	return row(title).querySelector<HTMLElement>('[role="switch"]')!;
}

function isOn(control: HTMLElement) {
	return control.getAttribute("aria-checked") === "true";
}

function isDisabled(control: HTMLElement) {
	return (
		control.hasAttribute("data-disabled") ||
		control.getAttribute("aria-disabled") === "true" ||
		(control instanceof HTMLButtonElement && control.disabled)
	);
}

function comboIn(title: string) {
	return row(title).querySelector<HTMLButtonElement>('[role="combobox"]')!;
}

function shown(combo: HTMLElement) {
	return combo.textContent?.replace("▼", "").replace(/\s+/g, " ").trim();
}

/** The listbox of the one select that is open now (closed popups linger). */
function openListbox() {
	return (
		Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]'))
			.filter(
				(box) =>
					!(box.hasAttribute("data-closed") || box.closest("[data-closed]"))
			)
			.at(-1) ?? null
	);
}

function openOptions() {
	return Array.from(
		openListbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
	);
}

function optionLabels() {
	return openOptions().map((option) =>
		option.textContent?.replace(/\s+/g, " ").trim()
	);
}

async function choose(combo: HTMLElement, label: string) {
	await act(async () => combo.click());
	await settle(() => optionLabels().includes(label), `option ${label}`);
	const option = openOptions().find(
		(candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === label
	)!;
	await act(async () => option.click());
	await settle(
		() => combo.getAttribute("aria-expanded") === "false",
		`listbox for ${label} closed`
	);
	await flush();
}

async function toggle(control: HTMLElement) {
	await act(async () => control.click());
	await flush();
}

async function press(key: string) {
	const target = document.activeElement;
	if (!target) {
		throw new Error("No focused element for keyboard input");
	}
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
		target.dispatchEvent(
			new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key })
		);
	});
	await flush(20);
}

async function openPage(title: string) {
	await act(async () => buttonNamed(title).click());
	await settle(
		() => element!.querySelector("h3")?.textContent === title,
		`page ${title}`
	);
}

async function backToIndex() {
	await act(async () => buttonNamed("Appearance").click());
	await settle(() => visibleText().includes("Customize"), "index");
}

function indexRows() {
	return Array.from(
		element!.querySelectorAll<HTMLButtonElement>(
			'[data-slot="item-title"] > button'
		)
	).map((button) => button.textContent?.trim());
}

function consumer(name: string) {
	return consumerElement!.querySelector<HTMLElement>(
		`[data-consumer="${name}"]`
	)!;
}

/**
 * Whether a DOM query matched. Assertions compare this boolean rather than the
 * node itself, so a failure reports true/false instead of serialising a
 * happy-dom element tree.
 */
function present(node: Element | null | undefined) {
	return node !== null && node !== undefined;
}

function storedJson(key: string): unknown {
	const raw = localStorage.getItem(key);
	return raw === null ? null : JSON.parse(raw);
}

function shadowOf(scope: Element, selector: string) {
	const host = scope.querySelector(selector);
	if (!host?.shadowRoot) {
		throw new Error(`No rendered shadow root for ${selector}`);
	}
	return host.shadowRoot;
}

function treePreviewHost() {
	return element!.querySelector<HTMLElement>("file-tree-container")!;
}

function treeItems() {
	const host = treePreviewHost();
	return Array.from(
		host?.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? []
	).map((item) => item.getAttribute("data-item-path"));
}

const PAGE_TITLES = [
	"Language & vibe",
	"Layout & text",
	"Motion & effects",
	"Interface",
	"Chat view",
	"Interfaces",
	"Usage meter",
	"Diff viewer",
	"File tree",
	"Reset",
];

beforeEach(() => {
	localStorage.clear();
	// The Interfaces page is listed only when a workspace interface can be opened.
	useProductModeStore.setState({ osAccess: true });
	resetUsageBarPrefs();
	setChatPickerPlacement("composer");
	localStorage.clear();
	exchanges.length = 0;
	undeclared.length = 0;
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	localStorage.setItem("appearance-coverage-unrelated", "keep-me");
});

afterEach(async () => {
	clearSettingReveal();
	previewSeasonalTheme(null);
	await unmountTab();
	await unmountConsumers();
	queryClient?.clear();
	// Let a debounced theme publication from this case land before the next.
	await flush(450);
	for (const property of ["--font-sans", "--font-heading", "--font-code"]) {
		document.documentElement.style.removeProperty(property);
	}
});

afterAll(async () => {
	await server.stop(true);
	setSystemTime();
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

// ── Customize (SettingsSubpages) ───────────────────────────────────────────
test("Customize hides the Interfaces page when no workspace interface can be opened", async () => {
	useProductModeStore.setState({ osAccess: false });
	await mountTab();
	expect(indexRows()).toEqual(
		PAGE_TITLES.filter((title) => title !== "Interfaces")
	);
});

test("Customize lists every Appearance page, pushes the chosen page with Back, and a settings-search reveal opens the page that holds its row", async () => {
	await mountTab();
	expect(indexRows()).toEqual(PAGE_TITLES);
	// The theme intro stays on the index, above the page list.
	expect(visibleText()).toContain("Choose how Ryu looks on your device.");

	await openPage("Diff viewer");
	expect(visibleText()).toContain(
		"How code changes are drawn: layout, themes, and markers."
	);
	expect(hasRow("Line numbers")).toBe(true);
	expect(indexRows()).toEqual([]);
	expect(visibleText()).not.toContain("Choose how Ryu looks on your device.");
	await backToIndex();
	expect(indexRows()).toEqual(PAGE_TITLES);

	// Each row is a native button, so it is a Tab stop that the platform
	// activates with Enter and Space.
	const usageRow = buttonNamed("Usage meter");
	expect(usageRow.getAttribute("type")).toBe("button");
	await act(async () => usageRow.focus());
	expect(document.activeElement === usageRow).toBe(true);

	// A search hit for a row on a closed page opens that page while the pane
	// is already mounted (the subscription path).
	const percentEntry = SETTINGS_ENTRIES.find(
		(entry) => entry.id === "appearance.usage-meter.show-percentage"
	)!;
	await act(async () => requestSettingReveal(percentEntry));
	await settle(() => hasRow("Show percentage"), "reveal opened Usage meter");
	expect(element!.querySelector("h3")?.textContent).toBe("Usage meter");
	await unmountTab();

	// …and when the request was made a beat BEFORE the pane mounted (the
	// section switch), the first render already lands on the right page.
	const lineNumbers = SETTINGS_ENTRIES.find(
		(entry) => entry.id === "appearance.diff-viewer.line-numbers"
	)!;
	requestSettingReveal(lineNumbers);
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () => root!.render(providers(<AppearanceTab />)));
	await settle(() => hasRow("Line numbers"), "reveal before mount");
	expect(element.querySelector("h3")?.textContent).toBe("Diff viewer");

	// A stale index entry naming a page that no longer exists leaves the user
	// where they are instead of on a blank page.
	await backToIndex();
	await act(async () =>
		requestSettingReveal({
			...lineNumbers,
			id: "appearance.removed-row",
			subpage: "removed-page",
		})
	);
	await flush(60);
	expect(indexRows()).toEqual(PAGE_TITLES);
	expect(undeclared).toEqual([]);
});

// ── Typography ─────────────────────────────────────────────────────────────
test("UI font, Heading font and Code font persist the picked family, apply it to the document, publish it to Core, and are restored by boot and by a remount", async () => {
	await mountTab();
	await openPage("Layout & text");
	expect(shown(comboIn("UI font"))).toBe("Inter");
	expect(shown(comboIn("Heading font"))).toBe("Geist");
	expect(shown(comboIn("Code font"))).toBe("System Mono");

	await choose(comboIn("UI font"), "Geist");
	expect(shown(comboIn("UI font"))).toBe("Geist");
	expect(localStorage.getItem("ryu_ui_font")).toBe(
		'"Geist Variable", "Geist", sans-serif'
	);
	expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
		'"Geist Variable", "Geist", sans-serif'
	);
	// Picking one font leaves the other two unwritten.
	expect(localStorage.getItem("ryu_heading_font")).toBeNull();
	expect(localStorage.getItem("ryu_code_font")).toBeNull();

	await choose(comboIn("Heading font"), "System UI");
	expect(
		document.documentElement.style.getPropertyValue("--font-heading")
	).toBe("system-ui, -apple-system, sans-serif");

	// Keyboard: ArrowDown opens on the saved choice, arrows move, Enter commits
	// and returns focus to the trigger.
	const code = comboIn("Code font");
	await act(async () => code.focus());
	await press("ArrowDown");
	expect(code.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement?.textContent?.trim()).toBe("System Mono");
	await press("ArrowDown");
	expect(document.activeElement?.textContent?.trim()).toBe("JetBrains Mono");
	await press("Enter");
	expect(code.getAttribute("aria-expanded")).toBe("false");
	expect(document.activeElement === code).toBe(true);
	expect(shown(code)).toBe("JetBrains Mono");
	expect(document.documentElement.style.getPropertyValue("--font-code")).toBe(
		'"JetBrains Mono", ui-monospace, monospace'
	);

	// Core acknowledges one debounced theme document carrying all three fonts.
	await settle(
		() =>
			publishedThemePrefs().some(
				(entry) =>
					entry.prefs.codeFont === '"JetBrains Mono", ui-monospace, monospace'
			),
		"theme prefs published"
	);
	const latest = publishedThemePrefs().at(-1)!;
	expect(latest.authorization).toBe(`Bearer ${CORE_TOKEN}`);
	expect(latest.prefs.uiFont).toBe('"Geist Variable", "Geist", sans-serif');
	expect(latest.prefs.headingFont).toBe("system-ui, -apple-system, sans-serif");
	expect(latest.prefs.codeFont).toBe(
		'"JetBrains Mono", ui-monospace, monospace'
	);

	// Boot: the document loses its inline fonts; the app's real boot path
	// re-applies them from storage alone.
	await unmountTab();
	for (const property of ["--font-sans", "--font-heading", "--font-code"]) {
		document.documentElement.style.removeProperty(property);
	}
	initTheme();
	expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
		'"Geist Variable", "Geist", sans-serif'
	);
	expect(
		document.documentElement.style.getPropertyValue("--font-heading")
	).toBe("system-ui, -apple-system, sans-serif");
	expect(document.documentElement.style.getPropertyValue("--font-code")).toBe(
		'"JetBrains Mono", ui-monospace, monospace'
	);
	await mountTab();
	await openPage("Layout & text");
	expect(shown(comboIn("UI font"))).toBe("Geist");
	expect(shown(comboIn("Heading font"))).toBe("System UI");
	expect(shown(comboIn("Code font"))).toBe("JetBrains Mono");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
	expect(undeclared).toEqual([]);
});

// ── Notification layout ────────────────────────────────────────────────────
function notificationSlider() {
	return row("Notification layout").querySelector<HTMLElement>(
		'[role="slider"][aria-label="Notification layout"]'
	)!;
}

test("Notification layout steps by keyboard through Unified, Grouped and Split; the caption, stored layout and the sidebar's subscribed consumer follow, and a remount restores the step", async () => {
	await mountConsumers(["notification"]);
	await mountTab();
	await openPage("Interface");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Unified");
	expect(notificationSlider().getAttribute("aria-valuenow")).toBe("2");
	expect(visibleText()).toContain(
		"Blend everything into one compact notification stack."
	);
	expect(consumer("notification-layout").textContent).toBe("unified");

	await act(async () => notificationSlider().focus());
	await press("ArrowLeft");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Grouped");
	expect(visibleText()).toContain(
		"Share one tray while keeping Inbox and announcements grouped."
	);
	expect(localStorage.getItem("ryu:notification-layout")).toBe("grouped");
	expect(consumer("notification-layout").textContent).toBe("grouped");

	await press("Home");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Split");
	expect(visibleText()).toContain(
		"Keep the announcement stack and Inbox tray separate."
	);
	expect(localStorage.getItem("ryu:notification-layout")).toBe("split");
	expect(consumer("notification-layout").textContent).toBe("split");
	// Below the first step there is nowhere to go; nothing changes.
	await press("ArrowLeft");
	expect(localStorage.getItem("ryu:notification-layout")).toBe("split");

	await unmountTab();
	await mountTab();
	await openPage("Interface");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Split");
	await act(async () => notificationSlider().focus());
	await press("End");
	expect(localStorage.getItem("ryu:notification-layout")).toBe("unified");
	expect(consumer("notification-layout").textContent).toBe("unified");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});

// ── Seasonal effects ───────────────────────────────────────────────────────
function previewButton() {
	return buttonNamed(
		visibleText().includes("Previewing…") ? "Previewing…" : "Preview"
	);
}

test("Seasonal effects drives the titlebar particle layer, obeys Enable animations, pins or previews a Season, and closing Settings releases a running preview", async () => {
	await mountConsumers(["season"]);
	await mountTab();
	await openPage("Motion & effects");
	const seasonal = () => switchIn("Seasonal effects");
	const season = () => comboIn("Season");
	expect(isOn(seasonal())).toBe(true);
	expect(shown(season())).toBe("Automatic");
	// Automatic follows the calendar: October is Halloween.
	expect(consumer("season").dataset.season).toBe("halloween");
	expect(consumer("season").textContent).toContain("🎃");

	await toggle(seasonal());
	expect(isOn(seasonal())).toBe(false);
	expect(localStorage.getItem("ryu:seasonal-effects")).toBe("false");
	expect(consumer("season").dataset.season).toBe("none");
	expect(isDisabled(season())).toBe(true);
	// Preview still works with the switch off, and shows today's season.
	expect(isDisabled(previewButton())).toBe(false);
	await act(async () => previewButton().click());
	await settle(() => consumer("season").dataset.season === "halloween");
	expect(previewButton().textContent).toBe("Previewing…");
	expect(isDisabled(previewButton())).toBe(true);
	// Closing Settings mid-preview hands the titlebar back to the real setting.
	await unmountTab();
	await settle(() => consumer("season").dataset.season === "none");

	await mountTab();
	await openPage("Motion & effects");
	expect(isOn(seasonal())).toBe(false);
	await toggle(seasonal());
	expect(localStorage.getItem("ryu:seasonal-effects")).toBe("true");
	await choose(season(), "❄️ Christmas");
	expect(shown(season())).toBe("❄️ Christmas");
	expect(localStorage.getItem("ryu:seasonal-theme")).toBe("christmas");
	expect(consumer("season").dataset.season).toBe("christmas");

	// The master motion switch turns the whole feature off, controls included.
	await toggle(switchIn("Enable animations"));
	expect(localStorage.getItem("ryu:animations-enabled")).toBe("false");
	expect(consumer("season").dataset.season).toBe("none");
	expect(isDisabled(seasonal())).toBe(true);
	expect(isDisabled(season())).toBe(true);
	expect(isDisabled(previewButton())).toBe(true);
	expect(isDisabled(switchIn("Animate streaming chat text"))).toBe(true);
	await toggle(switchIn("Enable animations"));
	expect(consumer("season").dataset.season).toBe("christmas");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});

// ── Chat model & agent picker ──────────────────────────────────────────────
test("Chat model & agent picker moves the picker into the tab bar, names the choice after a remount, and a fresh store load reads it back", async () => {
	await mountConsumers(["chat-picker"]);
	await mountTab();
	await openPage("Interface");
	const picker = () => comboIn("Chat model & agent picker");
	expect(shown(picker())).toBe("In composer");
	expect(
		present(
			consumer("chat-picker").querySelector(
				'[data-testid="chat-model-agent-picker-composer"]'
			)
		)
	).toBe(true);

	await choose(picker(), "In tab bar actions tray");
	expect(shown(picker())).toBe("In tab bar actions tray");
	expect(localStorage.getItem("ryu:chat-picker-placement")).toBe("tab-bar");
	expect(
		present(
			consumer("chat-picker").querySelector(
				'[data-testid="chat-model-agent-picker-tab-bar"]'
			)
		)
	).toBe(true);

	// Reopening Settings must name the stored choice, not print its raw id.
	await unmountTab();
	await mountTab();
	await openPage("Interface");
	expect(shown(picker())).toBe("In tab bar actions tray");

	// An independent load of the store module reads the persisted placement.
	const fresh = await import(
		`@/src/hooks/useChatPickerPlacement.ts?reload=${Date.now()}`
	);
	const freshValues: string[] = [];
	function FreshReader() {
		const [placement] = fresh.useChatPickerPlacement();
		freshValues.push(placement);
		return null;
	}
	const probe = document.createElement("div");
	const probeRoot = createRoot(probe);
	await act(async () => probeRoot.render(<FreshReader />));
	await act(async () => probeRoot.unmount());
	expect(freshValues.at(-1)).toBe("tab-bar");

	await choose(picker(), "In composer");
	expect(localStorage.getItem("ryu:chat-picker-placement")).toBe("composer");
	expect(
		present(
			consumer("chat-picker").querySelector(
				'[data-testid="chat-model-agent-picker-composer"]'
			)
		)
	).toBe(true);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});

// ── Usage meter ────────────────────────────────────────────────────────────
function composerMeter() {
	return consumer("usage-composer").querySelector<HTMLElement>(
		'[aria-label^="Session:"]'
	);
}

function sidebarMeter() {
	return consumer("usage-sidebar").querySelector<HTMLElement>(
		'[aria-label^="Session:"]'
	);
}

test("each Usage meter switch reshapes the real composer and sidebar meters fed by Core, enforces its dependencies, persists, and is read back by a fresh store load", async () => {
	await mountConsumers(["usage"]);
	await mountTab();
	await openPage("Usage meter");
	await settle(() => composerMeter() !== null, "composer meter from Core");
	await settle(() => sidebarMeter() !== null, "sidebar meter from Core");
	const usageCalls = exchanges.filter(
		(e) => e.path === `/api/agents/${USAGE_AGENT}/usage`
	);
	expect(usageCalls.length).toBeGreaterThan(0);
	expect(
		usageCalls.every((e) => e.authorization === `Bearer ${CORE_TOKEN}`)
	).toBe(true);

	// Defaults: visible, sidebar, ring, no inline percent, percent used.
	expect(composerMeter()!.getAttribute("aria-label")).toBe("Session: 40% used");
	expect(present(composerMeter()!.querySelector("svg circle"))).toBe(true);
	expect(composerMeter()!.textContent).not.toContain("40%");
	for (const title of [
		"Show usage meter",
		"Show in sidebar",
		"Show progress bar",
		"Circular progress ring",
	]) {
		expect(isOn(switchIn(title))).toBe(true);
	}
	expect(isOn(switchIn("Show percentage"))).toBe(false);
	expect(isOn(switchIn("Show remaining instead of used"))).toBe(false);

	await toggle(switchIn("Show percentage"));
	expect(composerMeter()!.textContent).toContain("40%");
	expect(sidebarMeter()!.textContent).toContain("40%");

	await toggle(switchIn("Show remaining instead of used"));
	expect(composerMeter()!.getAttribute("aria-label")).toBe("Session: 60% left");
	expect(composerMeter()!.textContent).toContain("60%");
	expect(sidebarMeter()!.getAttribute("aria-label")).toBe("Session: 60% left");

	await toggle(switchIn("Circular progress ring"));
	expect(present(composerMeter()!.querySelector("svg circle"))).toBe(false);
	const bar = composerMeter()!.querySelector<HTMLElement>(
		"span.rounded-full > span"
	);
	// The fill's width is the `--usage-fill` custom property its stylesheet reads.
	expect(bar?.style.getPropertyValue("--usage-fill")).toBe("60%");

	await toggle(switchIn("Show progress bar"));
	expect(present(composerMeter()!.querySelector("svg circle"))).toBe(false);
	expect(
		present(composerMeter()!.querySelector("span.rounded-full > span"))
	).toBe(false);
	// The ring choice only means something while a bar is drawn.
	expect(isDisabled(switchIn("Circular progress ring"))).toBe(true);
	expect(composerMeter()!.textContent).toContain("60%");

	await toggle(switchIn("Show in sidebar"));
	expect(consumer("usage-sidebar").textContent).toBe("");
	expect(present(composerMeter())).toBe(true);

	await toggle(switchIn("Show usage meter"));
	expect(consumer("usage-composer").textContent).toBe("");
	for (const title of [
		"Show progress bar",
		"Circular progress ring",
		"Show percentage",
		"Show remaining instead of used",
	]) {
		expect(isDisabled(switchIn(title))).toBe(true);
	}
	expect(isDisabled(switchIn("Show in sidebar"))).toBe(false);

	const expected = {
		barStyle: "bar",
		mode: "remaining",
		showBar: false,
		showPercent: true,
		sidebar: false,
		visible: false,
	};
	expect(storedJson("ryu:usage-bar-prefs")).toEqual(expected);

	// An independent load of the store module reads the same choices back.
	const fresh = await import(
		`@/src/hooks/useUsageBarPrefs.ts?reload=${Date.now()}`
	);
	let freshPrefs: unknown = null;
	function FreshReader() {
		freshPrefs = fresh.useUsageBarPrefs();
		return null;
	}
	const probe = document.createElement("div");
	const probeRoot = createRoot(probe);
	await act(async () => probeRoot.render(<FreshReader />));
	await act(async () => probeRoot.unmount());
	expect(freshPrefs).toEqual(expected);

	await unmountTab();
	await mountTab();
	await openPage("Usage meter");
	expect(isOn(switchIn("Show usage meter"))).toBe(false);
	expect(isOn(switchIn("Show in sidebar"))).toBe(false);
	expect(isOn(switchIn("Show percentage"))).toBe(true);
	expect(isOn(switchIn("Show remaining instead of used"))).toBe(true);
	// Turning the composer meter back on restores the remembered shape.
	await toggle(switchIn("Show usage meter"));
	await settle(() => composerMeter() !== null, "composer meter returns");
	expect(composerMeter()!.getAttribute("aria-label")).toBe("Session: 60% left");
	expect(present(composerMeter()!.querySelector("svg circle"))).toBe(false);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
	expect(undeclared).toEqual([]);
});

// ── Diff viewer ────────────────────────────────────────────────────────────
function diffPreview() {
	return shadowOf(element!, "diffs-container");
}

function previewPre() {
	return diffPreview().querySelector<HTMLElement>("pre[data-diff]")!;
}

function consumerDiff() {
	return shadowOf(consumer("diff"), "diffs-container");
}

function rendered(read: () => unknown) {
	try {
		return Boolean(read());
	} catch {
		return false;
	}
}

/** The viewer's generated theme stylesheet inside its shadow root. */
function themeCss() {
	return (
		diffPreview().querySelector("style[data-theme-css]")?.textContent ?? ""
	);
}

function tokenColor(scope: ShadowRoot, token: string, side: "light" | "dark") {
	const span = Array.from(
		scope.querySelectorAll<HTMLElement>("span[style]")
	).find((candidate) => candidate.textContent?.trim() === token);
	return span?.style.getPropertyValue(`--diffs-token-${side}`) ?? "";
}

test("Diff viewer selects and switches redraw the live preview and the workspace diff, persist, and survive a remount", async () => {
	await mountConsumers(["diff"]);
	await mountTab();
	await openPage("Diff viewer");
	await settle(
		() => rendered(previewPre) && rendered(consumerDiff),
		"both diffs rendered"
	);

	expect(previewPre().getAttribute("data-indicators")).toBe("bars");
	expect(previewPre().hasAttribute("data-background")).toBe(true);
	expect(previewPre().getAttribute("data-overflow")).toBe("scroll");
	expect(previewPre().hasAttribute("data-disable-line-numbers")).toBe(false);
	expect(
		diffPreview().querySelectorAll("[data-line-number-content]").length
	).toBeGreaterThan(0);
	expect(
		diffPreview().querySelectorAll("[data-diff-span]").length
	).toBeGreaterThan(0);
	const pierreLight = tokenColor(diffPreview(), "export", "light");
	expect(pierreLight).not.toBe("");
	const pierreDark = tokenColor(diffPreview(), "export", "dark");
	expect(pierreDark).not.toBe("");

	// Theme mode pins which of the two syntax themes the viewer resolves: Auto
	// leaves the colour scheme to the app; Dark and Light force it on the host.
	expect(themeCss()).not.toContain("color-scheme:");
	await choose(comboIn("Theme mode"), "Dark");
	await settle(
		() => themeCss().includes("color-scheme: dark"),
		"diff forced dark"
	);
	await choose(comboIn("Theme mode"), "Light");
	await settle(
		() => themeCss().includes("color-scheme: light"),
		"diff forced light"
	);

	// Dark theme swaps the dark-mode token colours (Dracula's keyword pink).
	await choose(comboIn("Dark theme"), "Dracula");
	await settle(
		() => tokenColor(diffPreview(), "export", "dark") !== pierreDark,
		"dark syntax theme changed"
	);
	expect(tokenColor(diffPreview(), "export", "dark").toUpperCase()).toBe(
		"#FF79C6"
	);

	await choose(comboIn("Change markers"), "Classic (+/−)");
	await settle(
		() => previewPre().getAttribute("data-indicators") === "classic",
		"classic markers"
	);
	await choose(comboIn("Change markers"), "None");
	// "None" drops the gutter-marker mode from the rendered diff entirely.
	await settle(
		() => !previewPre().hasAttribute("data-indicators"),
		"no markers"
	);

	await choose(comboIn("Inline highlighting"), "Off");
	await settle(
		() => diffPreview().querySelectorAll("[data-diff-span]").length === 0,
		"inline highlighting off"
	);

	await toggle(switchIn("Line backgrounds"));
	await settle(
		() => !previewPre().hasAttribute("data-background"),
		"backgrounds off"
	);

	// The gutter is hidden by the viewer's stylesheet through this marker.
	await toggle(switchIn("Line numbers"));
	await settle(
		() => previewPre().hasAttribute("data-disable-line-numbers"),
		"line numbers hidden"
	);

	await toggle(switchIn("Wrap long lines"));
	await settle(
		() => previewPre().getAttribute("data-overflow") === "wrap",
		"wrapping"
	);

	await choose(comboIn("Light theme"), "Solarized Light");
	await settle(
		() => tokenColor(diffPreview(), "export", "light") !== pierreLight,
		"light syntax theme changed"
	);

	// Hunk separators and unchanged context need collapsed lines, which the
	// workspace diff of a 40-line file has between its two hunks.
	await toggle(switchIn("Line numbers"));
	await settle(
		() => !previewPre().hasAttribute("data-disable-line-numbers"),
		"line numbers shown again"
	);
	await choose(comboIn("Hunk separators"), "Line info");
	await settle(
		() => /unmodified lines/i.test(consumerDiff().textContent ?? ""),
		"line-info separator"
	);
	expect(present(consumerDiff().querySelector('[data-line="20"]'))).toBe(false);
	await toggle(switchIn("Expand unchanged context"));
	await settle(
		() => consumerDiff().querySelector('[data-line="20"]') !== null,
		"unchanged context expanded"
	);
	expect(/unmodified lines/i.test(consumerDiff().textContent ?? "")).toBe(
		false
	);

	expect(storedJson("ryu:diff-view-prefs")).toMatchObject({
		darkTheme: "dracula",
		themeMode: "light",
		diffIndicators: "none",
		expandUnchanged: true,
		hunkSeparators: "line-info",
		lightTheme: "solarized-light",
		lineDiffType: "none",
		showBackground: false,
		showLineNumbers: true,
		wrapLines: true,
	});

	await unmountTab();
	await mountTab();
	await openPage("Diff viewer");
	expect(shown(comboIn("Change markers"))).toBe("None");
	expect(shown(comboIn("Inline highlighting"))).toBe("Off");
	expect(shown(comboIn("Hunk separators"))).toBe("Line info");
	expect(shown(comboIn("Light theme"))).toBe("Solarized Light");
	expect(shown(comboIn("Dark theme"))).toBe("Dracula");
	expect(shown(comboIn("Theme mode"))).toBe("Light");
	expect(isOn(switchIn("Line backgrounds"))).toBe(false);
	expect(isOn(switchIn("Line numbers"))).toBe(true);
	expect(isOn(switchIn("Wrap long lines"))).toBe(true);
	expect(isOn(switchIn("Expand unchanged context"))).toBe(true);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
}, 30_000);

// ── File tree ──────────────────────────────────────────────────────────────
test("File tree Initial state, Search mode, Light theme and Dark theme reshape and recolour the live tree preview, persist, and survive a remount", async () => {
	await mountTab();
	await openPage("File tree");
	await settle(() => treeItems().length > 0, "tree preview rendered");
	expect(treeItems()).toEqual(["src/", "package.json", "README.md"]);

	await choose(comboIn("Initial state"), "Expanded");
	await settle(
		() => treeItems().includes("src/components/Button.tsx"),
		"folders expanded"
	);
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		initialExpansion: "open",
	});

	// Light theme: Match app theme keeps app colours; a named theme paints the
	// preview with that theme's own sidebar surface (Solarized Light's base2).
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-background")
	).toBe("");
	await choose(comboIn("Light theme"), "Solarized Light");
	await settle(
		() =>
			treePreviewHost().style.getPropertyValue(
				"--appearance-tree-background"
			) !== "",
		"tree theme applied"
	);
	expect(
		treePreviewHost()
			.style.getPropertyValue("--appearance-tree-background")
			.toLowerCase()
	).toBe("#eee8d5");

	// Search mode applies when the preview's search box filters.
	await toggle(switchIn("Search box"));
	await choose(comboIn("Search mode"), "Hide non-matches");
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		searchMode: "hide-non-matches",
		showSearch: true,
	});
	const search = () =>
		treePreviewHost().shadowRoot?.querySelector<HTMLInputElement>("input") ??
		null;
	await settle(() => search() !== null, "search box rendered");
	await act(async () => {
		const input = search()!;
		input.value = "Card";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await settle(
		() =>
			treeItems().includes("src/components/Card.tsx") &&
			!treeItems().includes("README.md"),
		"non-matches hidden"
	);

	// Dark theme applies while the app itself is dark: switch the app with the
	// Theme radio on the index, then pick a dark tree theme.
	await backToIndex();
	const darkMode = element!.querySelector<HTMLInputElement>(
		'input[name="theme"][value="dark"]'
	)!;
	await act(async () => darkMode.click());
	await settle(
		() => document.documentElement.classList.contains("dark"),
		"app dark"
	);
	expect(localStorage.getItem("theme")).toBe("dark");
	await openPage("File tree");
	await settle(
		() =>
			treePreviewHost()?.style.getPropertyValue("--appearance-tree-scheme") ===
			"dark",
		"tree follows the dark app"
	);
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-background")
	).toBe("");
	await choose(comboIn("Dark theme"), "Dracula");
	await settle(
		() =>
			treePreviewHost().style.getPropertyValue(
				"--appearance-tree-background"
			) !== "",
		"dark tree theme applied"
	);
	// Dracula's own sidebar surface and foreground.
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-background")
	).toBe("#21222C");
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-foreground")
	).toBe("#F8F8F2");
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		darkTheme: "dracula",
		lightTheme: "solarized-light",
	});

	await unmountTab();
	await mountTab();
	await openPage("File tree");
	expect(shown(comboIn("Initial state"))).toBe("Expanded");
	expect(shown(comboIn("Light theme"))).toBe("Solarized Light");
	expect(shown(comboIn("Dark theme"))).toBe("Dracula");
	expect(shown(comboIn("Search mode"))).toBe("Hide non-matches");
	await settle(
		() => treeItems().includes("src/components/Button.tsx"),
		"expanded after remount"
	);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});

// ── Reset appearance ───────────────────────────────────────────────────────
test("Reset appearance confirms first; Cancel keeps every change, Confirm restores every row's default, republishes to Core, and keeps saved presets and unrelated storage", async () => {
	const customTheme = JSON.stringify([
		{
			id: "custom-light-kept",
			label: "Kept preset",
			mode: "light",
			preview: { bg: "#ffffff", primary: "#ff0000", surface: "#eeeeee" },
			tokens: { "--primary": "#ff0000" },
		},
	]);
	localStorage.setItem("ryu_custom_themes", customTheme);
	localStorage.setItem("ryu_ui_font", "system-ui, -apple-system, sans-serif");
	localStorage.setItem("ryu:notification-layout", "split");
	setChatPickerPlacement("tab-bar");
	localStorage.setItem("ryu:seasonal-effects", "false");
	localStorage.setItem("ryu:seasonal-theme", "christmas");
	localStorage.setItem(
		"ryu:diff-view-prefs",
		JSON.stringify({ diffIndicators: "none", showLineNumbers: false })
	);
	localStorage.setItem(
		"ryu:file-tree-prefs",
		JSON.stringify({ initialExpansion: "open", searchMode: "hide-non-matches" })
	);
	const seeded = Object.fromEntries(
		Array.from({ length: localStorage.length }, (_, i) => {
			const key = localStorage.key(i)!;
			return [key, localStorage.getItem(key)];
		})
	);

	await mountTab();
	await openPage("Reset");
	expect(visibleText()).toContain("Saved custom theme presets are kept.");
	await act(async () => buttonNamed("Reset to defaults").click());
	expect(buttonNamed("Confirm reset").textContent).toBe("Confirm reset");
	await act(async () => buttonNamed("Cancel").click());
	expect(buttonNamed("Reset to defaults").textContent).toBe(
		"Reset to defaults"
	);
	for (const [key, value] of Object.entries(seeded)) {
		expect(localStorage.getItem(key)).toBe(value);
	}

	await act(async () => buttonNamed("Reset to defaults").click());
	await act(async () => buttonNamed("Confirm reset").click());
	expect(buttonNamed("Reset to defaults").textContent).toBe(
		"Reset to defaults"
	);

	expect(localStorage.getItem("ryu_ui_font")).toBe(
		'"Inter Variable", "Inter", sans-serif'
	);
	expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
		'"Inter Variable", "Inter", sans-serif'
	);
	expect(localStorage.getItem("ryu:notification-layout")).toBe("unified");
	expect(localStorage.getItem("ryu:chat-picker-placement")).toBe("composer");
	expect(localStorage.getItem("ryu:seasonal-effects")).toBe("true");
	expect(localStorage.getItem("ryu:seasonal-theme")).toBe("auto");
	expect(storedJson("ryu:diff-view-prefs")).toMatchObject({
		diffIndicators: "bars",
		showLineNumbers: true,
	});
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		initialExpansion: "closed",
		searchMode: "expand-matches",
	});
	expect(storedJson("ryu:usage-bar-prefs")).toEqual({
		barStyle: "ring",
		mode: "used",
		showBar: true,
		showPercent: false,
		sidebar: true,
		visible: true,
	});
	expect(localStorage.getItem("theme")).toBe("system");
	// Kept: the saved preset and storage Appearance does not own.
	expect(localStorage.getItem("ryu_custom_themes")).toBe(customTheme);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");

	await settle(
		() =>
			publishedThemePrefs().some(
				(entry) =>
					entry.prefs.uiFont === '"Inter Variable", "Inter", sans-serif'
			),
		"reset published to Core"
	);

	// Every page reads the defaults back.
	await backToIndex();
	await openPage("Layout & text");
	expect(shown(comboIn("UI font"))).toBe("Inter");
	await backToIndex();
	await openPage("Interface");
	expect(shown(comboIn("Chat model & agent picker"))).toBe("In composer");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Unified");
	await backToIndex();
	await openPage("Motion & effects");
	expect(isOn(switchIn("Seasonal effects"))).toBe(true);
	expect(shown(comboIn("Season"))).toBe("Automatic");
	await backToIndex();
	await openPage("Diff viewer");
	expect(shown(comboIn("Change markers"))).toBe("Bars");
	expect(isOn(switchIn("Line numbers"))).toBe(true);
	await backToIndex();
	await openPage("File tree");
	expect(shown(comboIn("Initial state"))).toBe("Collapsed");
	expect(shown(comboIn("Search mode"))).toBe("Expand matches");
	expect(undeclared).toEqual([]);
}, 30_000);

// ── Layout & sizing ────────────────────────────────────────────────────────
function slider(label: string) {
	const match = element!.querySelector<HTMLElement>(
		`[role="slider"][aria-label="${label}"]`
	);
	if (!match) {
		throw new Error(`No "${label}" slider`);
	}
	return match;
}

async function stepSlider(label: string, key: string) {
	await act(async () => slider(label).focus());
	await press(key);
}

function rootStyle(property: string) {
	return document.documentElement.style.getPropertyValue(property);
}

const themeNumbersSchema = z
	.object({
		cardSpacing: z.number().nullable(),
		contrast: z.number(),
		radius: z.number(),
		scale: z.number(),
		spacing: z.number(),
	})
	.passthrough();

test("Layout & sizing sliders step by keyboard and resize the document, publish the theme values to Core, and the boot path and a remount restore them", async () => {
	const sidebarEvents: unknown[] = [];
	const onSidebarWidth = (event: Event) =>
		sidebarEvents.push((event as CustomEvent<unknown>).detail);
	window.addEventListener("ryu:sidebar-width", onSidebarWidth);
	try {
		await mountTab();
		await openPage("Layout & text");
		expect(slider("Muted contrast").getAttribute("aria-valuetext")).toBe("50");
		expect(slider("Roundness").getAttribute("aria-valuetext")).toBe("0.625rem");
		expect(slider("Scale (UI zoom)").getAttribute("aria-valuetext")).toBe(
			"100%"
		);

		await stepSlider("Muted contrast", "ArrowRight");
		expect(localStorage.getItem("ryu_contrast")).toBe("51");
		expect(rootStyle("--muted")).toContain("var(--muted-base), white");

		await stepSlider("Roundness", "ArrowRight");
		expect(slider("Roundness").getAttribute("aria-valuetext")).toBe("0.650rem");
		expect(Number.parseFloat(rootStyle("--radius"))).toBeCloseTo(0.65, 5);

		await stepSlider("Scale (UI zoom)", "ArrowRight");
		expect(slider("Scale (UI zoom)").getAttribute("aria-valuetext")).toBe(
			"105%"
		);
		expect(Number(rootStyle("--ryu-ui-scale"))).toBeCloseTo(1.05, 5);
		expect(Number(document.documentElement.style.zoom)).toBeCloseTo(1.05, 5);

		await stepSlider("Zoom (spacing)", "ArrowLeft");
		expect(Number.parseFloat(rootStyle("--spacing"))).toBeCloseTo(0.235, 5);

		await stepSlider("Card padding", "ArrowRight");
		expect(Number.parseFloat(rootStyle("--card-pad"))).toBeCloseTo(0.98, 5);
		expect(Number.parseFloat(rootStyle("--card-pad-sm"))).toBeCloseTo(0.735, 5);

		await stepSlider("Chat width", "End");
		expect(slider("Chat width").getAttribute("aria-valuetext")).toBe("960px");
		expect(rootStyle("--an-max-width")).toBe("960px");

		await stepSlider("Sidebar width", "Home");
		expect(slider("Sidebar width").getAttribute("aria-valuetext")).toBe(
			"180px"
		);
		expect(localStorage.getItem("ryu:sidebar-width")).toBe("180");
		expect(sidebarEvents.at(-1)).toBe(180);

		// The theme-owned values reach Core in one debounced document.
		await settle(
			() =>
				publishedThemePrefs().some(
					(entry) => themeNumbersSchema.parse(entry.prefs).contrast === 51
				),
			"layout published"
		);
		const published = themeNumbersSchema.parse(
			publishedThemePrefs().at(-1)!.prefs
		);
		expect(published.contrast).toBe(51);
		expect(published.radius).toBeCloseTo(0.65, 5);
		expect(published.scale).toBeCloseTo(1.05, 5);
		expect(published.spacing).toBeCloseTo(0.235, 5);
		expect(published.cardSpacing).toBeCloseTo(0.98, 5);

		// Boot restores the document from storage alone.
		await unmountTab();
		for (const property of [
			"--radius",
			"--spacing",
			"--ryu-ui-scale",
			"--card-pad",
			"--an-max-width",
		]) {
			document.documentElement.style.removeProperty(property);
		}
		document.documentElement.style.zoom = "";
		initTheme();
		expect(Number.parseFloat(rootStyle("--radius"))).toBeCloseTo(0.65, 5);
		expect(Number.parseFloat(rootStyle("--spacing"))).toBeCloseTo(0.235, 5);
		expect(Number(document.documentElement.style.zoom)).toBeCloseTo(1.05, 5);
		expect(Number.parseFloat(rootStyle("--card-pad"))).toBeCloseTo(0.98, 5);
		expect(rootStyle("--an-max-width")).toBe("960px");

		await mountTab();
		await openPage("Layout & text");
		expect(slider("Muted contrast").getAttribute("aria-valuetext")).toBe("51");
		expect(slider("Roundness").getAttribute("aria-valuetext")).toBe("0.650rem");
		expect(slider("Scale (UI zoom)").getAttribute("aria-valuetext")).toBe(
			"105%"
		);
		expect(slider("Zoom (spacing)").getAttribute("aria-valuetext")).toBe(
			"0.235rem"
		);
		expect(slider("Card padding").getAttribute("aria-valuetext")).toBe(
			"0.98rem"
		);
		expect(slider("Chat width").getAttribute("aria-valuetext")).toBe("960px");
		expect(slider("Sidebar width").getAttribute("aria-valuetext")).toBe(
			"180px"
		);
		expect(localStorage.getItem("appearance-coverage-unrelated")).toBe(
			"keep-me"
		);
		expect(undeclared).toEqual([]);
	} finally {
		window.removeEventListener("ryu:sidebar-width", onSidebarWidth);
		for (const property of [
			"--radius",
			"--spacing",
			"--ryu-ui-scale",
			"--card-pad",
			"--card-pad-sm",
			"--an-max-width",
			"--muted",
			"--muted-foreground",
		]) {
			document.documentElement.style.removeProperty(property);
		}
		document.documentElement.style.zoom = "";
	}
});

// ── Diff layout and file-tree behaviour ────────────────────────────────────
function treeShadow() {
	return treePreviewHost().shadowRoot!;
}

function treeItem(path: string) {
	return treeShadow().querySelector<HTMLElement>(`[data-item-path="${path}"]`);
}

function workspaceTreeItems() {
	const host = consumer("workspace-tree").querySelector("file-tree-container");
	return Array.from(
		host?.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? []
	).map((item) => item.getAttribute("data-item-path"));
}

async function pressOn(target: HTMLElement, key: string) {
	await act(async () => {
		target.focus();
		target.click();
	});
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				composed: true,
				key,
			})
		);
	});
	await flush(60);
}

test("Diff Layout and the file tree Density, Icons, Colored icons, Sticky folders, Search box, Drag and drop, Inline rename and Flatten change the live previews and the workspace tree, and survive a remount", async () => {
	await mountConsumers(["workspace-tree"]);
	await mountTab();
	await openPage("Diff viewer");
	await settle(() => rendered(previewPre), "diff preview");
	expect(previewPre().getAttribute("data-diff-type")).toBe("split");
	expect(previewPre().querySelectorAll("code")).toHaveLength(2);
	await choose(comboIn("Layout"), "Stacked (inline)");
	await settle(
		() => previewPre().getAttribute("data-diff-type") === "single",
		"stacked diff"
	);
	expect(previewPre().querySelectorAll("code")).toHaveLength(1);

	await backToIndex();
	await openPage("File tree");
	await settle(() => treeItem("package.json") !== null, "tree preview");

	// Density sets the row height.
	expect(treeItem("package.json")!.style.minHeight).toBe("30px");
	await choose(comboIn("Density"), "Compact");
	await settle(
		() => treeItem("package.json")?.style.minHeight === "24px",
		"compact rows"
	);
	expect(treePreviewHost().style.getPropertyValue("--trees-item-height")).toBe(
		"24px"
	);

	// Icons: the complete set has a JSON glyph; Minimal falls back to the
	// generic file glyph.
	const jsonIcon = () =>
		treeItem("package.json")?.querySelector("use")?.getAttribute("href");
	expect(jsonIcon()).toBe("#file-tree-builtin-json");
	const wrapper = () =>
		treeShadow().querySelector("[data-file-tree-virtualized-wrapper]");
	expect(wrapper()?.getAttribute("data-file-tree-colored-icons")).toBe("true");
	await toggle(switchIn("Colored icons"));
	await settle(
		() => !wrapper()?.hasAttribute("data-file-tree-colored-icons"),
		"monochrome icons"
	);
	await choose(comboIn("Icons"), "Minimal");
	await settle(() => jsonIcon() === "#file-tree-icon-file", "minimal icons");

	// Sticky folders pins an expanded parent above its children.
	await choose(comboIn("Initial state"), "Expanded");
	await settle(
		() =>
			treeShadow().querySelector("[data-file-tree-sticky-overlay]") !== null,
		"sticky overlay"
	);
	await toggle(switchIn("Sticky folders"));
	await settle(
		() =>
			treeShadow().querySelector("[data-file-tree-sticky-overlay]") === null,
		"no sticky overlay"
	);

	// Search box shows and hides the filter.
	expect(present(treeShadow().querySelector("input"))).toBe(false);
	await toggle(switchIn("Search box"));
	await settle(() => treeShadow().querySelector("input") !== null, "search");
	await toggle(switchIn("Search box"));
	await settle(() => treeShadow().querySelector("input") === null, "no search");

	// Drag and drop makes rows draggable.
	expect(treeItem("package.json")!.getAttribute("draggable")).toBeNull();
	await toggle(switchIn("Drag and drop"));
	await settle(
		() => treeItem("package.json")?.getAttribute("draggable") === "true",
		"draggable rows"
	);

	// Inline rename: F2 opens the rename field only while it is on.
	await pressOn(treeItem("package.json")!, "F2");
	expect(present(treeShadow().querySelector("[data-item-rename-input]"))).toBe(
		false
	);
	await toggle(switchIn("Inline rename"));
	await settle(() => treeItem("package.json") !== null, "tree remounted");
	await pressOn(treeItem("package.json")!, "F2");
	await settle(
		() =>
			treeShadow()
				.querySelector("[data-item-rename-input]")
				?.getAttribute("aria-label") === "Rename package.json",
		"rename field"
	);

	// Flatten collapses a single-child folder chain in the workspace tree.
	await settle(
		() => workspaceTreeItems().includes("packages/"),
		"workspace tree"
	);
	await toggle(switchIn("Flatten empty directories"));
	await settle(
		() => workspaceTreeItems().includes("packages/app/src/"),
		"flattened chain"
	);

	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		coloredIcons: false,
		density: "compact",
		dragAndDrop: true,
		flattenEmptyDirectories: true,
		iconSet: "minimal",
		renaming: true,
		showSearch: false,
		stickyFolders: false,
	});
	expect(storedJson("ryu:diff-view-prefs")).toMatchObject({
		diffStyle: "unified",
	});

	await unmountTab();
	await mountTab();
	await openPage("File tree");
	expect(shown(comboIn("Density"))).toBe("Compact");
	expect(shown(comboIn("Icons"))).toBe("Minimal");
	for (const [title, on] of [
		["Colored icons", false],
		["Sticky folders", false],
		["Search box", false],
		["Flatten empty directories", true],
		["Drag and drop", true],
		["Inline rename", true],
	] as const) {
		expect(isOn(switchIn(title))).toBe(on);
	}
	await settle(
		() => treeItem("package.json")?.getAttribute("draggable") === "true",
		"remounted preview keeps drag and drop"
	);
	await backToIndex();
	await openPage("Diff viewer");
	expect(shown(comboIn("Layout"))).toBe("Stacked (inline)");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
}, 30_000);

// ── Chat detail, message preferences and motion ────────────────────────────
const transcriptSchema = z
	.object({
		animationsEnabled: z.boolean(),
		expandCodeBlocks: z.boolean(),
		expandCommands: z.boolean(),
		expandFileEdits: z.boolean(),
		groupToolUses: z.boolean(),
		hideToolDetail: z.boolean(),
		inferenceStats: z.boolean(),
		markdownComposer: z.boolean(),
		openAtBottom: z.boolean(),
		pinUserMessage: z.boolean(),
		streamAnimation: z.boolean(),
	})
	.passthrough();

function transcript() {
	return transcriptSchema.parse(
		JSON.parse(consumer("transcript").textContent ?? "{}")
	);
}

function detailSlider() {
	return row("Detail level").querySelector<HTMLElement>(
		'[role="slider"][aria-label="Detail level"]'
	)!;
}

/** The level named above the track — what a sighted user reads. */
function detailCaption() {
	return row("Detail level").querySelector(".justify-end > span")?.textContent;
}

test("Detail level and Advanced detail drive what the transcript shows, None disables only the tool-row switches, and message and motion preferences reach the chat", async () => {
	await mountConsumers(["transcript"]);
	await mountTab();
	await openPage("Chat view");
	// Shipped defaults read as the Compact preset.
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Compact");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: false,
		expandCommands: false,
		expandFileEdits: false,
		groupToolUses: true,
		hideToolDetail: false,
	});

	await act(async () => detailSlider().focus());
	await press("End");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Detailed");
	expect(detailCaption()).toBe("Detailed");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: true,
		expandCommands: true,
		expandFileEdits: true,
		groupToolUses: false,
		hideToolDetail: false,
	});
	await press("ArrowLeft");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Minimal");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: false,
		expandCommands: false,
		expandFileEdits: true,
		groupToolUses: true,
	});

	// None hides tool detail but keeps the expansion choices for later.
	await press("Home");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("None");
	expect(transcript()).toMatchObject({
		expandFileEdits: true,
		hideToolDetail: true,
	});
	await act(async () => buttonNamed("Advanced detail").click());
	await settle(() => hasRow("Group tool uses"), "advanced open");
	expect(visibleText()).toContain(
		"Detail level is None, so the chat shows no tool calls to expand."
	);
	expect(isDisabled(switchIn("Group tool uses"))).toBe(true);
	expect(isDisabled(switchIn("Show file edits expanded"))).toBe(true);
	expect(isDisabled(switchIn("Auto-expand commands"))).toBe(true);
	expect(isDisabled(switchIn("Expand code blocks"))).toBe(false);
	await toggle(switchIn("Expand code blocks"));
	expect(transcript().expandCodeBlocks).toBe(true);

	// Stepping back up restores a preset; a manual divergence reads Custom.
	await act(async () => detailSlider().focus());
	await press("ArrowRight");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Compact");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: false,
		expandFileEdits: false,
		hideToolDetail: false,
	});
	await toggle(switchIn("Auto-expand commands"));
	expect(transcript().expandCommands).toBe(true);
	// The caption and the announced value must agree: both say Custom.
	expect(detailCaption()).toBe("Custom");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Custom");
	await toggle(switchIn("Group tool uses"));
	expect(transcript().groupToolUses).toBe(false);
	await toggle(switchIn("Show file edits expanded"));
	expect(transcript().expandFileEdits).toBe(true);

	// Message preferences.
	for (const [title, key] of [
		["Pin user message while scrolling", "pinUserMessage"],
		["Open chats at the latest message", "openAtBottom"],
		["Session stats", "inferenceStats"],
	] as const) {
		expect(transcript()[key]).toBe(true);
		await toggle(switchIn(title));
		expect(transcript()[key]).toBe(false);
	}

	// Motion: streaming text follows its own switch and the master switch.
	await backToIndex();
	await openPage("Motion & effects");
	expect(transcript().streamAnimation).toBe(true);
	await toggle(switchIn("Animate streaming chat text"));
	expect(transcript().streamAnimation).toBe(false);
	await toggle(switchIn("Animate streaming chat text"));
	expect(transcript().streamAnimation).toBe(true);
	await toggle(switchIn("Enable animations"));
	expect(transcript()).toMatchObject({
		animationsEnabled: false,
		streamAnimation: false,
	});
	expect(document.documentElement.getAttribute("data-ryu-animations")).toBe(
		"off"
	);
	await toggle(switchIn("Enable animations"));
	expect(document.documentElement.hasAttribute("data-ryu-animations")).toBe(
		false
	);
	expect(transcript().streamAnimation).toBe(true);

	// Rich Markdown composer.
	await backToIndex();
	await openPage("Interface");
	expect(transcript().markdownComposer).toBe(false);
	await toggle(switchIn("Rich Markdown composer"));
	expect(transcript().markdownComposer).toBe(true);

	// A remount reopens Advanced on its own, because the combination is Custom.
	await unmountTab();
	await mountTab();
	await openPage("Chat view");
	expect(detailCaption()).toBe("Custom");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Custom");
	expect(hasRow("Group tool uses")).toBe(true);
	expect(isOn(switchIn("Group tool uses"))).toBe(false);
	expect(isOn(switchIn("Show file edits expanded"))).toBe(true);
	expect(isOn(switchIn("Auto-expand commands"))).toBe(true);
	expect(isOn(switchIn("Pin user message while scrolling"))).toBe(false);
	expect(isOn(switchIn("Open chats at the latest message"))).toBe(false);
	expect(isOn(switchIn("Session stats"))).toBe(false);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});
