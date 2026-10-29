import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// apps/desktop/src/pages/CompanionPage.tsx
//
// Companion overlay page. Renders a floating context pill showing the active
// app/window name and a truncated selected-text preview (via Shadow :3030),
// plus three one-shot action pills (Explain / Summarize / Translate) that
// compose the current screen context into a prompt and stream the answer from
// Core /api/chat/stream via the Gateway.
//
// Context is refreshed each time the overlay opens (via useCompanionContext).
// When Shadow is down the pill renders a graceful "context unavailable" notice
// and still allows asking with whatever context is available (none).
//
// The "Do it" section (issue #201) exposes a small, named set of Ghost
// computer-use actions (focus / click / screenshot) through Core's MCP tool
// path. Every action requires explicit user confirmation before execution —
// no Ghost action auto-runs. Action success/failure is shown inline.
// The full Ghost tool catalog is not exposed here (out of scope).
//
// Each companion capability (context read, proactive, do-it) is independently
// opt-in and disabled by default (issue #202). The per-capability state is
// loaded from tauri-plugin-store and passed in from CompanionPage so gating
// happens at the section level.

import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { CompanionConsent } from "@/src/components/companion/ConsentSettings.tsx";
import ConsentSettings from "@/src/components/companion/ConsentSettings.tsx";
import { SuggestionChip } from "@/src/components/companion/SuggestionChip.tsx";
import { useCompanionWindowSizing } from "@/src/components/companion/useCompanionWindowSizing.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { AskIntent } from "@/src/hooks/useAskScreen.ts";
import { useAskScreen } from "@/src/hooks/useAskScreen.ts";
import { useCompanionContext } from "@/src/hooks/useCompanionContext.ts";
import type { UseGhostActionResult } from "@/src/hooks/useGhostAction.ts";
import { useGhostAction } from "@/src/hooks/useGhostAction.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { GhostActionInput, GhostActionKind } from "@/src/lib/api/mcp.ts";

/** Label shown on each action button. */
const ACTION_LABELS = {
	explain: "Explain",
	summarize: "Summarize",
	translate: "Translate",
} satisfies Record<AskIntent, string>;

/** Max characters of selected text shown in the context pill. */
const SELECTION_PREVIEW_MAX = 120;

// ── Ghost action config ────────────────────────────────────────────────────

interface GhostActionDef {
	/** Short description shown in the confirmation panel. */
	description: (target?: string) => string;
	kind: GhostActionKind;
	label: string;
	/** When true, a target input is shown before confirmation. */
	needsTarget: boolean;
	/** Placeholder text for the target input. */
	targetPlaceholder?: string;
}

const GHOST_ACTIONS: GhostActionDef[] = [
	{
		kind: "focus",
		label: "Focus App",
		needsTarget: true,
		targetPlaceholder: "App name (e.g. Finder)",
		description: (t) => `Bring "${t ?? "app"}" to the foreground.`,
	},
	{
		kind: "click",
		label: "Click Element",
		needsTarget: true,
		targetPlaceholder: "Element text or name",
		description: (t) => `Click the element matching "${t ?? "element"}".`,
	},
	{
		kind: "screenshot",
		label: "Screenshot",
		needsTarget: false,
		description: () => "Take a screenshot of the current screen.",
	},
];

// ── GhostActionPanel ──────────────────────────────────────────────────────

interface GhostActionPanelProps {
	agentId: string | null;
	ghost: UseGhostActionResult;
	loadError: boolean;
	noAgentWarning: boolean;
	onRetryAgents: () => void;
}

function GhostActionPanel({
	ghost,
	agentId,
	loadError,
	noAgentWarning,
	onRetryAgents,
}: GhostActionPanelProps) {
	// Which action is staged for confirmation; null = none.
	const [staged, setStaged] = useState<GhostActionDef | null>(null);
	// Target text for actions that need it.
	const [targetText, setTargetText] = useState("");

	const handleActionClick = useCallback((def: GhostActionDef) => {
		setTargetText("");
		setStaged(def);
	}, []);

	const handleConfirm = useCallback(async () => {
		if (
			!(staged && agentId) ||
			ghost.executing ||
			(staged.needsTarget && !targetText.trim())
		) {
			return;
		}
		const input: GhostActionInput = {
			kind: staged.kind,
			target: staged.needsTarget ? targetText.trim() || undefined : undefined,
		};
		ghost.confirm(input);
		setStaged(null);
		await ghost.execute(agentId);
	}, [staged, targetText, agentId, ghost]);

	const handleCancel = useCallback(() => {
		setStaged(null);
		setTargetText("");
	}, []);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Do it
				</span>
				{(ghost.result || ghost.error) && (
					<button
						className="text-muted-foreground text-xs hover:text-foreground"
						onClick={ghost.reset}
						type="button"
					>
						Clear
					</button>
				)}
			</div>

			{loadError && (
				<div
					className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-status-destructive text-xs"
					role="alert"
				>
					<span>
						Couldn't reach your device to load its agents. Check that it's
						online and try again.
					</span>
					<button
						className="shrink-0 font-medium underline hover:no-underline"
						onClick={onRetryAgents}
						type="button"
					>
						Retry
					</button>
				</div>
			)}

			{!loadError && noAgentWarning && (
				<p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-status-warning text-xs dark:text-status-warning">
					No agents set up yet — add one on the Agents page to enable desktop
					actions.
				</p>
			)}

			{/* Action buttons */}
			{!staged && (
				<div className="flex gap-2">
					{GHOST_ACTIONS.map((def) => (
						<button
							className="flex-1 rounded-md bg-background px-3 py-2 font-medium text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
							disabled={ghost.executing || !agentId}
							key={def.kind}
							onClick={() => handleActionClick(def)}
							type="button"
						>
							{def.label}
						</button>
					))}
				</div>
			)}

			{/* Confirmation panel — the explicit approval gate (issue #201 AC2) */}
			{staged && (
				<div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
					<p className="font-medium text-sm">Confirm: {staged.label}</p>
					{staged.needsTarget && (
						<input
							aria-label="Target"
							autoFocus
							className="rounded-md bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
							onChange={(e) => setTargetText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									handleConfirm().catch(() => undefined);
								}
								if (e.key === "Escape") {
									handleCancel();
								}
							}}
							placeholder={staged.targetPlaceholder}
							type="text"
							value={targetText}
						/>
					)}
					<p className="text-muted-foreground text-xs">
						{staged.description(
							staged.needsTarget ? targetText.trim() || undefined : undefined
						)}{" "}
						This action will run on your desktop. Continue?
					</p>
					<div className="flex gap-2">
						<button
							className="flex-1 rounded-md bg-background px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
							disabled={staged.needsTarget && !targetText.trim()}
							onClick={() => {
								handleConfirm().catch(() => undefined);
							}}
							type="button"
						>
							Run
						</button>
						<button
							className="flex-1 rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
							onClick={handleCancel}
							type="button"
						>
							Cancel
						</button>
					</div>
				</div>
			)}

			{/* Executing indicator */}
			{ghost.executing && (
				<p className="animate-skeleton text-muted-foreground text-xs">
					Running action…
				</p>
			)}

			{/* Result — success or failure reflected back into the overlay (AC3) */}
			{ghost.result && (
				<output
					className={`rounded-md border px-3 py-2 text-xs ${
						ghost.result.ok
							? "border-success/30 bg-success/10 text-status-success dark:text-status-success"
							: "border-destructive/40 bg-destructive/10 text-status-destructive"
					}`}
				>
					{ghost.result.ok ? (
						<>
							<span className="font-medium">Done.</span>
							{isNativeText(ghost.result.output) &&
								ghost.result.output.trim() !== "" && (
									<p className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">
										{ghost.result.output}
									</p>
								)}
						</>
					) : (
						<>
							<span className="font-medium">Failed: </span>
							{ghost.result.error ?? "Unknown error"}
						</>
					)}
				</output>
			)}

			{/* Network / Core error (before a result arrives) */}
			{ghost.error && !ghost.result && (
				<div
					className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-status-destructive text-xs"
					role="alert"
				>
					{ghost.error}
				</div>
			)}
		</div>
	);
}

// ── ContextPill ───────────────────────────────────────────────────────────

interface ContextPillProps {
	activeApp: string | null | undefined;
	capturePaused: boolean;
	contextReadEnabled: boolean;
	loading: boolean;
	onOpenSettings: () => void;
	overflow: boolean;
	selectedText: string | undefined;
	unavailable: boolean;
}

/** Renders the context pill content based on the current consent and capture state. */
function ContextPill({
	contextReadEnabled,
	capturePaused,
	loading,
	unavailable,
	activeApp,
	selectedText,
	overflow,
	onOpenSettings,
}: ContextPillProps): ReactNode {
	if (!contextReadEnabled) {
		return (
			<span className="text-muted-foreground">
				Context read is disabled. Enable it in{" "}
				<button
					className="underline hover:text-foreground"
					onClick={onOpenSettings}
					type="button"
				>
					Settings
				</button>
				.
			</span>
		);
	}
	if (capturePaused) {
		return (
			<span className="text-muted-foreground">
				Capture is paused — resume in{" "}
				<button
					className="underline hover:text-foreground"
					onClick={onOpenSettings}
					type="button"
				>
					Settings
				</button>
				.
			</span>
		);
	}
	if (loading) {
		return (
			<span className="animate-skeleton text-muted-foreground">
				Capturing context…
			</span>
		);
	}
	if (unavailable) {
		return (
			<span className="text-muted-foreground">
				Context unavailable — Shadow is not running. Proceeding without screen
				context.
			</span>
		);
	}
	if (activeApp) {
		return (
			<span className="text-muted-foreground">
				<span className="font-medium text-foreground">{activeApp}</span>
				{selectedText ? ` · "${selectedText}${overflow ? "…" : ""}"` : ""}
			</span>
		);
	}
	return (
		<span className="text-muted-foreground">
			Ready — trigger an action to capture context.
		</span>
	);
}

// ── RecordingIndicator ────────────────────────────────────────────────────

/** Always-visible recording indicator — AC3: reflects capture state. */
function RecordingIndicator({
	paused,
	enabled,
}: {
	paused: boolean;
	enabled: boolean;
}) {
	return (
		<div
			aria-live="polite"
			className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
				paused || !enabled
					? "border border-warning/30 bg-warning/10 text-status-warning dark:text-status-warning"
					: "border border-success/30 bg-success/10 text-status-success dark:text-status-success"
			}`}
		>
			<span
				aria-hidden
				className={`h-1.5 w-1.5 rounded-full ${paused || !enabled ? "bg-warning" : "bg-success motion-safe:animate-pulse"}`}
			/>
			{enabled ? (paused ? "Capture paused" : "Capturing") : "Capture disabled"}
		</div>
	);
}

// ── CompanionPage ─────────────────────────────────────────────────────────

/** Tab identifiers for the overlay's two views. */
type OverlayTab = "companion" | "settings";

export default function CompanionPage() {
	const { sizingRef, sizingError } = useCompanionWindowSizing();
	const activeNode = useActiveNode();
	const nodeUrl = activeNode.url;
	const nodeToken = activeNode.token ?? null;
	const nodeUserJwt = activeNode.userJwt ?? null;
	const target: ApiTarget = {
		url: nodeUrl,
		token: nodeToken,
		userJwt: nodeUserJwt,
	};

	// ── Consent state (AC1: per-capability opt-in, disabled by default) ──────
	const [consent, setConsent] = useState<CompanionConsent>({
		contextRead: false,
		proactive: false,
		doIt: false,
	});
	const [capturePaused, setCapturePaused] = useState(false);

	// ── Tab state ─────────────────────────────────────────────────────────────
	const [activeTab, setActiveTab] = useState<OverlayTab>("companion");

	// Context pill — only poll when context-read is enabled.
	const {
		context,
		proactive,
		unavailable,
		loading: ctxLoading,
		refresh,
	} = useCompanionContext(
		consent.contextRead && !capturePaused,
		5000,
		consent.proactive && !capturePaused
	);

	// Refresh on mount so the pill always shows up-to-date context when the
	// overlay is opened via the global hotkey.
	useEffect(() => {
		if (consent.contextRead && !capturePaused) {
			refresh();
		}
	}, [refresh, consent.contextRead, capturePaused]);

	const { loading, answer, error, ask, reset } = useAskScreen(target);
	const ghost = useGhostAction(target);

	// First available agent id — required by Core's MCP allowlist gate.
	const [firstAgentId, setFirstAgentId] = useState<string | null>(null);
	const [noAgents, setNoAgents] = useState(false);
	// Distinguishes a failed fetch (device unreachable) from a genuinely empty
	// list, so we never show the "no agents" empty-state on a connection error.
	const [agentsError, setAgentsError] = useState(false);
	// Bumped by the Retry affordance to re-run the load effect.
	const [reloadKey, setReloadKey] = useState(0);

	// Load the first agent on mount / node change. The companion overlay doesn't
	// need an agent selector — it just needs any registered agent whose allowlist
	// includes desktop actions (or no explicit allowlist, which is the default).
	useEffect(() => {
		let cancelled = false;
		setAgentsError(false);
		setFirstAgentId(null);
		setNoAgents(false);
		fetchAgents({ url: nodeUrl, token: nodeToken, userJwt: nodeUserJwt })
			.then((list) => {
				if (cancelled) {
					return;
				}
				const first = list[0]?.id ?? null;
				setFirstAgentId(first);
				setNoAgents(first === null);
			})
			.catch(() => {
				if (!cancelled) {
					setAgentsError(true);
				}
			});
		return () => {
			cancelled = true;
		};
		// `reloadKey` is load-bearing: `retryLoadAgents` (wired to `onRetryAgents`)
		// only bumps it, so without it the retry does nothing at all.
	}, [nodeUrl, nodeToken, nodeUserJwt, reloadKey]);

	const retryLoadAgents = useCallback(() => {
		setReloadKey((key) => key + 1);
	}, []);

	const handleAction = useCallback(
		async (intent: AskIntent) => {
			reset();
			await ask(intent, context);
		},
		[ask, reset, context]
	);

	const activeApp = context?.active_app;
	const selectedText = context?.selected_text?.slice(0, SELECTION_PREVIEW_MAX);
	const overflow =
		(context?.selected_text?.length ?? 0) > SELECTION_PREVIEW_MAX;

	const openSettings = useCallback(() => setActiveTab("settings"), []);

	return (
		<div
			className="flex max-h-screen min-h-[80px] flex-col gap-0 overflow-y-auto"
			ref={sizingRef}
		>
			{/* ── Header: recording indicator + tab bar ──────────────────────── */}
			<div className="flex items-center justify-between border-b px-4 py-2">
				<RecordingIndicator
					enabled={consent.contextRead}
					paused={capturePaused}
				/>
				<div className="flex gap-1">
					{(["companion", "settings"] satisfies OverlayTab[]).map((tab) => (
						<button
							className={`rounded px-3 py-1 font-medium text-xs transition-colors ${
								activeTab === tab
									? "bg-accent text-accent-foreground"
									: "text-muted-foreground hover:text-foreground"
							}`}
							key={tab}
							onClick={() => setActiveTab(tab)}
							type="button"
						>
							{tab === "companion" ? "Companion" : "Settings"}
						</button>
					))}
				</div>
			</div>

			{/* ── Settings tab ───────────────────────────────────────────────── */}
			<div hidden={activeTab !== "settings"}>
				<ConsentSettings
					onConsentChange={setConsent}
					onPausedChange={setCapturePaused}
				/>
			</div>

			{/* ── Companion tab ──────────────────────────────────────────────── */}
			{activeTab === "companion" && (
				<div className="flex flex-col gap-3 p-4">
					{/* Context pill (AC1: gated by contextRead) */}
					<div className="rounded-md bg-muted/40 px-3 py-2 text-xs">
						<ContextPill
							activeApp={activeApp}
							capturePaused={capturePaused}
							contextReadEnabled={consent.contextRead}
							loading={ctxLoading}
							onOpenSettings={openSettings}
							overflow={overflow}
							selectedText={selectedText}
							unavailable={unavailable}
						/>
					</div>

					{/* Proactive suggestion chip (AC1: gated by proactive consent) */}
					{consent.proactive && (
						<SuggestionChip onDismissed={refresh} suggestion={proactive} />
					)}

					{/* Ask action pills (gated by contextRead) */}
					{consent.contextRead && (
						<div className="flex gap-2">
							{
								/* SAFETY: ACTION_LABELS is the local unmodified authored explain/summarize/translate map checked against the complete AskIntent union; native Object.keys erases that own-key union to string[]. */ (
									Object.keys(ACTION_LABELS) as AskIntent[]
								).map((intent) => (
									<button
										className="flex-1 rounded-md bg-background px-3 py-2 font-medium text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
										disabled={loading || capturePaused}
										key={intent}
										onClick={() => {
											handleAction(intent).catch(() => undefined);
										}}
										type="button"
									>
										{ACTION_LABELS[intent]}
									</button>
								))
							}
						</div>
					)}

					{/* Streamed answer */}
					{(loading || answer) && (
						<div className="max-h-64 overflow-y-auto rounded-md bg-background p-3 text-sm">
							{answer ? (
								<p className="whitespace-pre-wrap">{answer}</p>
							) : (
								<p className="animate-skeleton text-muted-foreground text-xs">
									Thinking…
								</p>
							)}
						</div>
					)}

					{/* Inline error — never crashes, always visible in the overlay */}
					{error && (
						<div
							className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-status-destructive text-xs"
							role="alert"
						>
							{error}
						</div>
					)}

					{/* Separator */}
					<div className="border-t" />

					{/* Ghost computer-use actions (issue #201, gated by doIt — AC1) */}
					{consent.doIt ? (
						<GhostActionPanel
							agentId={firstAgentId}
							ghost={ghost}
							key={`${nodeUrl}:${nodeToken}:${nodeUserJwt}`}
							loadError={agentsError}
							noAgentWarning={noAgents}
							onRetryAgents={retryLoadAgents}
						/>
					) : (
						<div className="rounded-md bg-muted/30 px-3 py-2 text-muted-foreground text-xs">
							Desktop actions are disabled. Enable "Do it" in{" "}
							<button
								className="underline hover:text-foreground"
								onClick={() => setActiveTab("settings")}
								type="button"
							>
								Settings
							</button>
							.
						</div>
					)}
				</div>
			)}
			{sizingError && (
				<p className="px-4 py-2 text-status-destructive text-xs" role="alert">
					{sizingError}
				</p>
			)}
		</div>
	);
}
