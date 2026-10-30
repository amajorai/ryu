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

import { Button } from "@ryu/ui/components/button.tsx";
import { useCallback, useEffect, useState } from "react";
import type { CompanionConsent } from "@/src/components/companion/ConsentSettings.tsx";
import ConsentSettings from "@/src/components/companion/ConsentSettings.tsx";
import { SuggestionChip } from "@/src/components/companion/SuggestionChip.tsx";
import { useCompanionWindowSizing } from "@/src/components/companion/useCompanionWindowSizing.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { AskIntent } from "@/src/hooks/useAskScreen.ts";
import { useAskScreen } from "@/src/hooks/useAskScreen.ts";
import { useCompanionContext } from "@/src/hooks/useCompanionContext.ts";

import { useGhostAction } from "@/src/hooks/useGhostAction.ts";
import { fetchAgents } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	ACTION_LABELS,
	GhostActionPanel,
	SELECTION_PREVIEW_MAX,
} from "./CompanionPage.ghost-actions.tsx";
import { ContextPill, RecordingIndicator } from "./CompanionPage.parts.tsx";

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
			className="flex max-h-screen min-h-20 flex-col gap-0 overflow-y-auto"
			ref={sizingRef}
		>
			{/* ── Header: recording indicator + tab bar ──────────────────────── */}
			<div className="flex h-10 items-center justify-between px-4">
				<RecordingIndicator
					enabled={consent.contextRead}
					paused={capturePaused}
				/>
				<div className="flex gap-1">
					{(["companion", "settings"] satisfies OverlayTab[]).map((tab) => (
						<Button
							aria-pressed={activeTab === tab}
							className={activeTab === tab ? "bg-muted text-foreground" : ""}
							key={tab}
							onClick={() => setActiveTab(tab)}
							size="sm"
							type="button"
							variant="ghost-muted"
						>
							{tab === "companion" ? "Companion" : "Settings"}
						</Button>
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
					<div className="text-detail">
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
									<Button
										className="flex-1"
										disabled={loading || capturePaused}
										key={intent}
										onClick={() => {
											handleAction(intent).catch(() => undefined);
										}}
										size="sm"
										type="button"
										variant="outline"
									>
										{ACTION_LABELS[intent]}
									</Button>
								))
							}
						</div>
					)}

					{/* Streamed answer */}
					{(loading || answer) && (
						<div className="max-h-64 overflow-y-auto rounded-xl bg-muted px-4 py-3 text-sm">
							{answer ? (
								<p className="whitespace-pre-wrap">{answer}</p>
							) : (
								<p className="animate-skeleton text-detail text-muted-foreground">
									Thinking…
								</p>
							)}
						</div>
					)}

					{/* Inline error — never crashes, always visible in the overlay */}
					{error && (
						<div className="text-sm text-status-destructive" role="alert">
							{error}
						</div>
					)}

					{/* Separator */}
					<div className="border-border border-t" />

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
						<p className="text-detail text-muted-foreground">
							Desktop actions are disabled. Enable "Do it" in{" "}
							<Button
								className="h-auto p-0 text-detail"
								onClick={() => setActiveTab("settings")}
								type="button"
								variant="link"
							>
								Settings
							</Button>
							.
						</p>
					)}
				</div>
			)}
			{sizingError && (
				<p className="px-4 py-2 text-sm text-status-destructive" role="alert">
					{sizingError}
				</p>
			)}
		</div>
	);
}
