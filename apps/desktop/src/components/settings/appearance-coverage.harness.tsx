import { setSystemTime } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type ReactNode, useMemo } from "react";
import { z } from "zod";

// The REAL Appearance tab, mounted in happy-dom next to the REAL consumers its
// preferences drive (the composer/sidebar UsageBar, the workspace RichPatchDiff,
// the titlebar's seasonal particle layer). Core is a loopback Bun server reached
// through the production SDK, so theme-preference publication and the usage
// meter's data are real HTTP exchanges. Nothing under test is substituted.
export const nativeFetch = globalThis.fetch;
export const NativeResponse = globalThis.Response;
export const ownsDomRegistration = globalThis.document === undefined;
export const NativeAbortController = globalThis.AbortController;
export const NativeAbortSignal = globalThis.AbortSignal;
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

export const { ThemeProvider } = await import("next-themes");
export const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
export const { useProductModeStore } = await import(
	"@/src/lib/product-mode.ts"
);
export const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
export const { UsageBar } = await import(
	"@/components/agent-elements/input/usage-bar.tsx"
);
export const { RichPatchDiff } = await import(
	"@/src/components/diffs/RichPatchDiff.tsx"
);
export const { SeasonalParticles } = await import(
	"@/src/components/layout/SeasonalEffects.tsx"
);
export const { useActiveSeason, previewSeasonalTheme } = await import(
	"@/src/hooks/useSeasonalEffects.ts"
);
export const { useUsageBarPrefs, resetUsageBarPrefs } = await import(
	"@/src/hooks/useUsageBarPrefs.ts"
);
export const { useChatPickerPlacement, setChatPickerPlacement } = await import(
	"@/src/hooks/useChatPickerPlacement.ts"
);
export const { useDiffViewPrefs, diffViewPrefsToOptions } = await import(
	"@/src/hooks/useDiffViewPrefs.ts"
);
export const { useNotificationLayout } = await import(
	"@/src/lib/notification-layout.ts"
);
export const { initTheme } = await import("@/src/hooks/useThemePreset.ts");
export const { useFileTreePrefs, fileTreePrefsToOptions } = await import(
	"@/src/hooks/useFileTreePrefs.ts"
);
export const { FileTree, useFileTree } = await import("@pierre/trees/react");
export const { ChatDisplayPrefs } = await import(
	"@/src/components/chat/ChatDisplayPrefsProvider.tsx"
);
export const { useChatDisplayPrefs } = await import(
	"@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx"
);
export const { requestSettingReveal, clearSettingReveal } = await import(
	"@/src/lib/settings-focus.ts"
);
export const { SETTINGS_ENTRIES } = await import("@/src/lib/settings-index.ts");
export const { AppearanceTab } = await import("./AppearanceTab.tsx");

// ── Native Core fixture ────────────────────────────────────────────────────
export interface Exchange {
	authorization: string | null;
	body: string;
	method: string;
	path: string;
}
export const exchanges: Exchange[] = [];
export const undeclared: string[] = [];
export const CORE_TOKEN = "appearance-coverage-token";
export const USAGE_AGENT = "claude-code";
export const usageWire = {
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
export const server = Bun.serve({
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

export const themePrefsSchema = z
	.object({
		codeFont: z.string().optional(),
		headingFont: z.string().optional(),
		uiFont: z.string().optional(),
	})
	.passthrough();
/** Every theme-preference document Core acknowledged, parsed. */
export function publishedThemePrefs() {
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
export function NotificationLayoutConsumer() {
	const layout = useNotificationLayout();
	return <output data-consumer="notification-layout">{layout}</output>;
}

/** TitleBar: `useActiveSeason()` gates the SeasonalParticles layer. */
export function SeasonConsumer() {
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
export function ChatPickerConsumer() {
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
export function UsageConsumers() {
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

export const OLD_LINES = Array.from(
	{ length: 40 },
	(_, i) => `const line${i + 1} = ${i + 1};`
);
export const NEW_LINES = OLD_LINES.map((line, i) =>
	i === 2 || i === 36 ? line.replace(" = ", " = 100 + ") : line
);
export const OLD_FILE = {
	name: "values.ts",
	contents: `${OLD_LINES.join("\n")}\n`,
};
export const NEW_FILE = {
	name: "values.ts",
	contents: `${NEW_LINES.join("\n")}\n`,
};

/** WorkspacePanels' PatchDiffPanel: prefs → options → RichPatchDiff. */
export function DiffConsumer() {
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

export const WORKSPACE_PATHS = ["packages/app/src/main.ts", "README.md"];

/** WorkspacePanels' file tree: prefs → options → useFileTree, keyed remount. */
export function WorkspaceTree({
	options,
}: {
	options: ReturnType<typeof fileTreePrefsToOptions>;
}) {
	const { model } = useFileTree({ ...options, paths: WORKSPACE_PATHS });
	return <FileTree model={model} />;
}

export function WorkspaceTreeConsumer() {
	const prefs = useFileTreePrefs();
	const options = useMemo(() => fileTreePrefsToOptions(prefs), [prefs]);
	return (
		<div data-consumer="workspace-tree">
			<WorkspaceTree key={JSON.stringify(options)} options={options} />
		</div>
	);
}

/** Layout: the desktop ChatDisplayPrefs host feeding the transcript context. */
export function TranscriptPrefsReader() {
	const prefs = useChatDisplayPrefs();
	return <output data-consumer="transcript">{JSON.stringify(prefs)}</output>;
}

export function TranscriptConsumer() {
	return (
		<ChatDisplayPrefs>
			<TranscriptPrefsReader />
		</ChatDisplayPrefs>
	);
}

export type ConsumerName =
	| "chat-picker"
	| "diff"
	| "notification"
	| "season"
	| "transcript"
	| "usage"
	| "workspace-tree";
export const CONSUMERS: Record<ConsumerName, () => ReactNode> = {
	"chat-picker": () => <ChatPickerConsumer key="chat-picker" />,
	diff: () => <DiffConsumer key="diff" />,
	transcript: () => <TranscriptConsumer key="transcript" />,
	"workspace-tree": () => <WorkspaceTreeConsumer key="workspace-tree" />,
	notification: () => <NotificationLayoutConsumer key="notification" />,
	season: () => <SeasonConsumer key="season" />,
	usage: () => <UsageConsumers key="usage" />,
};
