import { OnboardingView } from "@ryu/blocks/desktop/onboarding";
import { Button } from "@ryu/ui/components/button";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { MicPermissionPrompt } from "@/src/components/permissions/MicPermissionPrompt.tsx";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import { track } from "@/src/lib/analytics.ts";
import {
	type AgentCatalogEntry,
	fetchAgentCatalog,
	installAgent,
} from "@/src/lib/api/agents.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import { installAndLaunchIsland } from "@/src/lib/api/island.ts";
import { setFeatureEnabled, TOGGLEABLE_FEATURES } from "@/src/lib/features.ts";
import { fetchCatalog, installSidecar } from "@/src/lib/services-api.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";

// How long the managed path polls the control plane for an already-provisioned
// node before falling back to the web servers page. Kept short: onboarding must
// never block on a live server coming up.
const ADOPT_MAX_MS = 20 * 1000;
const ADOPT_POLL_MS = 2000;

// Real progress for the auto-advancing (non-interactive) phases, so the bar fills
// as setup actually moves forward. Interactive phases (choose/agents/mic) render
// their own UI, not the bar, so they need no entry.
const PHASE_PROGRESS: Partial<Record<Phase, number>> = {
	starting: 12,
	installing: 60,
	finishing: 90,
	done: 100,
};

// Attach the resolved brand logo to each catalog entry so the shared onboarding
// AgentRow can render it next to the name — the presentational block can't reach
// the desktop's `AgentCatalogLogo` (local engine → SVGL → ACP CDN → Ryu fallback).
const withAgentLogo = (entry: AgentCatalogEntry) => ({
	...entry,
	logo: <AgentCatalogLogo entry={entry} size="20px" />,
});

// The 'agents', 'features', and 'mic' phases are interactive: the user picks which
// extra agents to add, chooses which features to keep on, then optionally enables
// the microphone. Every other phase auto-advances.
type Phase =
	| "starting"
	| "choose"
	| "installing"
	| "agents"
	| "features"
	| "mic"
	| "finishing"
	| "done";

const STATUS_MESSAGES: Record<Phase, string> = {
	starting: "Setting things up",
	choose: "How do you want to run Ryu?",
	installing: "Getting your local AI ready",
	agents: "Add your agents",
	features: "Choose your features",
	mic: "Enable voice input",
	finishing: "Almost there",
	done: "Ready!",
};

// The auto-advancing phases (`starting`/`installing`/`finishing`) can sit for a
// long time — `waitForLocalStack` polls the bundled inference install for up to
// 30 minutes. A single frozen line reads as "nothing is happening", so on those
// phases we cycle through several lines to make the wait feel alive. Interactive
// phases keep their single static heading from STATUS_MESSAGES.
const ROTATING_MESSAGES: Partial<Record<Phase, string[]>> = {
	starting: [
		"Setting things up",
		"Warming up the engine",
		"Preparing your workspace",
		"Tidying up the place",
		"Unpacking your assistant",
		"Getting comfortable",
	],
	installing: [
		"Installing the AI engine",
		"Downloading your local model",
		"Optimizing for your device",
		"Getting your local AI ready",
		"Teaching Ryu to think",
		"Wiring up the neurons",
		"Loading the brain cells",
		"Tuning the model weights",
		"Almost ready to chat",
		"This part can take a few minutes",
		"Hang tight, nearly there",
		"Putting the finishing touches",
	],
	finishing: [
		"Adding your agents",
		"Applying your preferences",
		"Finishing up",
		"Rolling out the welcome mat",
		"Polishing things off",
		"Just a sec",
	],
};

const ROTATE_INTERVAL_MS = 2600;

const POLL_INTERVAL_MS = 2000;
// How long onboarding will sit on the "installing" screen waiting for the local
// inference stack. A fast (cached) install finishes well inside this and the user
// lands ready. But the install is a sizable model/binary download that can run
// for many minutes — and on macOS it sometimes stays in `installing` for a long
// time — so we never hold the user hostage past this budget: the install keeps
// running in the background and the Models / Getting-Started surfaces track the
// rest. Better to drop them into the app than to freeze the setup screen.
const MAX_BLOCK_MS = 45 * 1000;
const LOCAL_STACK = "llamacpp";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll the control plane for a managed (Ryu Cloud) node the active org can
 * already reach, hydrating the node store on each tick. Resolves the first
 * managed node found, or undefined once the budget elapses or the flow is
 * cancelled. This only adopts a node that already exists; it never provisions.
 */
async function adoptManagedNode(
	hydrate: () => Promise<void>,
	isCancelled: () => boolean
): Promise<Node | undefined> {
	const deadline = Date.now() + ADOPT_MAX_MS;
	while (Date.now() < deadline && !isCancelled()) {
		try {
			await hydrate();
		} catch {
			// Control plane unreachable; keep polling within the budget.
		}
		const managed = useNodeStore.getState().nodes.find((n) => n.managed);
		if (managed) {
			return managed;
		}
		await sleep(ADOPT_POLL_MS);
		if (isCancelled()) {
			return undefined;
		}
	}
	return undefined;
}

/**
 * Poll Core's catalog until the bundled local inference stack finishes (or
 * fails) installing, or the grace budget passes — then let onboarding proceed
 * regardless.
 *
 * On Windows Core auto-triggers the llamacpp install on startup; on macOS that
 * auto-trigger is unreliable, so we kick the install ourselves the first time we
 * see `not_installed` (idempotent: a no-op if Core already started it). Either
 * way we only *block* for `MAX_BLOCK_MS`; the download continues in the
 * background if it's slow, so the user is never stuck on the setup screen.
 */
async function waitForLocalStack(
	node: { url: string; token: string | null },
	isCancelled: () => boolean
): Promise<void> {
	const deadline = Date.now() + MAX_BLOCK_MS;
	let triggered = false;
	while (Date.now() < deadline && !isCancelled()) {
		try {
			const catalog = await fetchCatalog(node.url, node.token ?? null);
			const entry = catalog.find((c) => c.name === LOCAL_STACK);
			if (
				entry?.installState === "installed" ||
				entry?.installState === "failed"
			) {
				return;
			}
			// Nothing has started the install (macOS path) — start it once, then
			// keep polling. Best-effort: a failed kick just leaves us polling.
			if (!triggered && entry?.installState === "not_installed") {
				triggered = true;
				await installSidecar(node.url, node.token ?? null, LOCAL_STACK).catch(
					() => undefined
				);
			}
		} catch {
			// Keep polling on transient network errors.
		}
		await sleep(POLL_INTERVAL_MS);
		if (isCancelled()) {
			return;
		}
	}
	// Grace budget elapsed and the stack is still installing — proceed anyway and
	// let it finish in the background rather than stranding the user here.
}

// The curated set of third-party agents worth surfacing on first run. Anything
// detectable but not on this list is too niche for onboarding and is hidden.
// Ids are matched against the live catalog, so entries that don't exist yet
// (e.g. a future Cursor agent) simply don't render until Core ships them.
const SUGGESTED_AGENT_IDS: readonly string[] = [
	"acp:claude",
	"cursor",
	"acp:cursor",
	"acp:codex",
	"acp:gemini",
	"hermes",
	"openclaw",
];

interface OnboardingAgents {
	/** Agents detected on the user's PATH — shown first, pre-selected. */
	found: AgentCatalogEntry[];
	/** Curated popular agents not already present — opt-in, not pre-selected. */
	suggested: AgentCatalogEntry[];
}

/**
 * Split the agent catalog into the two onboarding buckets: agents already found
 * on the system, and the curated "suggested" set the user can opt into. Ryu and
 * already-added agents are excluded from both. Best-effort: returns empty lists
 * on any error.
 */
async function loadOnboardingAgents(
	target: ApiTarget
): Promise<OnboardingAgents> {
	try {
		const agents = await fetchAgentCatalog(target);
		const installable = agents.filter((a) => a.id !== "ryu" && !a.added);
		const found = installable.filter((a) => a.detected === true);
		const suggested = SUGGESTED_AGENT_IDS.map((id) =>
			installable.find((a) => a.id === id)
		).filter(
			(a): a is AgentCatalogEntry => a !== undefined && a.detected !== true
		);
		return { found, suggested };
	} catch {
		return { found: [], suggested: [] };
	}
}

export default function OnboardingPage() {
	const navigate = useNavigate();
	const coreStatus = useAppStore((s) => s.coreStatus);
	const { getActiveNode, hydrateCloudNodes, setDefault } = useNodeStore();
	// The exact entitlement read NodeSelector's managed surfaces use (WS8): gates
	// the managed (Ryu Cloud) option on the plan's managed-inference flag.
	const { entitlement, loading: entitlementLoading } = useCreditsWallet();
	const [phase, setPhase] = useState<Phase>("starting");
	// Index into the rotating copy for the current auto-advancing phase.
	const [rotateIndex, setRotateIndex] = useState(0);
	// Managed adoption is polling the control plane for a provisioned node.
	const [managedBusy, setManagedBusy] = useState(false);
	// Webapp-only: the local reachability probe behind the "local" pick. The
	// desktop gates the whole `choose` step on its own Core already running, but
	// the webapp's `get_ryu_status` reports the HOSTED core, so `choose` renders
	// even with nothing on 127.0.0.1 — picking local there used to burn the 45s
	// waitForLocalStack budget and then drop the user into a broken app.
	const [localChecking, setLocalChecking] = useState(false);
	const [localUnreachable, setLocalUnreachable] = useState(false);
	// Guards the async local/managed setup against a late state update after the
	// page unmounts (it unmounts on the final navigate to /chat).
	const cancelledRef = useRef(false);
	useEffect(() => {
		cancelledRef.current = false;
		return () => {
			cancelledRef.current = true;
		};
	}, []);

	// Agents found on the user's system (pre-selected) and the curated suggested
	// set (opt-in). Only the flagship Ryu agent is installed by default.
	const [foundAgents, setFoundAgents] = useState<AgentCatalogEntry[]>([]);
	const [suggestedAgents, setSuggestedAgents] = useState<AgentCatalogEntry[]>(
		[]
	);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [submitting, setSubmitting] = useState(false);
	// Agents chosen on the picker, held while the later steps are shown.
	const [pendingAgents, setPendingAgents] = useState<string[]>([]);
	// Which feature the one-feature-per-step wizard is currently showing.
	const [featureIndex, setFeatureIndex] = useState(0);

	const finish = useCallback(
		async (target: ApiTarget, installIds: string[]) => {
			setPhase("finishing");

			// Add the agents the user picked. Best-effort: a failed add never blocks
			// onboarding, since the agent can still be added later from the store.
			await Promise.allSettled(
				installIds.map((id) => installAgent(target, id))
			);

			localStorage.setItem("ryu_onboarding_complete", "true");
			track({ event: "onboarding_completed" });
			localStorage.setItem("ryu_default_agent", "ryu");
			localStorage.setItem("ryu_first_run_kickstart", "true");

			await sleep(900);
			setPhase("done");
			await sleep(500);
			navigate("/chat");
		},
		[navigate]
	);

	// Hand off the chosen agents to the features wizard, which walks one optional
	// feature per step before the final (optional) mic step.
	const goToFeatures = useCallback((installIds: string[]) => {
		setPendingAgents(installIds);
		setFeatureIndex(0);
		// TEMP: the "Choose your features" step is disabled — skip straight to the
		// mic step so onboarding never lands on it. Features keep their defaults;
		// they remain toggleable later in Settings → Features.
		setPhase("mic");
	}, []);

	// Advance to the optional microphone step. Voice input is opt-in, so this
	// never blocks finishing — it just gives the OS mic prompt a controlled moment
	// with our own copy instead of firing mid-chat.
	const goToMic = useCallback(() => {
		setPhase("mic");
	}, []);

	// Apply the choice for the feature on screen (a disabled feature hides its
	// sidebar section), then advance to the next feature or on to the mic step.
	// Reads `featureIndex` from the render closure, so it's always the live step.
	const applyFeatureChoice = (enabled: boolean) => {
		const feature = TOGGLEABLE_FEATURES[featureIndex];
		if (feature) {
			setFeatureEnabled(feature.key, enabled);
		}
		const next = featureIndex + 1;
		if (next >= TOGGLEABLE_FEATURES.length) {
			goToMic();
		} else {
			setFeatureIndex(next);
		}
	};

	// The local (bring-your-own-keys) path: wait for the local stack, then detect
	// installable CLI agents and move to the interactive 'agents' step (or
	// straight to the feature wizard when none are installable / the catalog is
	// unreachable). This is the pre-WS8 behaviour, unchanged; it now runs from the
	// user's explicit "local" pick rather than automatically on Core coming up.
	const beginLocalSetup = useCallback(
		async (node: Node) => {
			const target = toTarget(node);

			setPhase("installing");
			// Best-effort: get the Island companion installed + launched during
			// onboarding so it's ready by first chat. Fire-and-forget (no `await`) and
			// non-fatal — it must never block or fail onboarding, and dev is a no-op.
			installAndLaunchIsland().catch(() => undefined);
			await waitForLocalStack(node, () => cancelledRef.current);
			if (cancelledRef.current) {
				return;
			}

			const { found, suggested } = await loadOnboardingAgents(target);
			if (cancelledRef.current) {
				return;
			}

			if (found.length > 0 || suggested.length > 0) {
				setFoundAgents(found);
				setSuggestedAgents(suggested);
				// Pre-select the ones already found on the user's system.
				setSelected(new Set(found.map((a) => a.id)));
				setPhase("agents");
				return;
			}

			goToFeatures([]);
		},
		[goToFeatures]
	);

	// Once Core is up, present the managed-vs-local choice (WS8) instead of
	// auto-running local setup. Downstream setup runs from the user's pick. Only
	// advances out of the initial 'starting' screen so a later phase is never
	// yanked back to the fork.
	useEffect(() => {
		if (coreStatus !== "running") {
			return;
		}
		setPhase((p) => (p === "starting" ? "choose" : p));
	}, [coreStatus]);

	// Local pick. Two fixes over the old straight-to-setup call:
	//
	// 1. Resolve the LOCAL node explicitly instead of `getActiveNode()`. On the
	//    webapp `preferLocalOrCloud()` may already have flipped the default to
	//    cloud, so the button labelled "local" was able to run local setup against
	//    the CLOUD node.
	// 2. Probe it before committing. `waitForLocalStack` swallows every error and
	//    proceeds anyway after 45s, so an unreachable node used to end with the
	//    user inside a fully broken app and onboarding marked complete. Instead
	//    stay on `choose` and offer the desktop download, which is the only way to
	//    actually get a local node.
	//
	// Desktop is unaffected: `choose` only renders once its own Core is running,
	// so the probe is a fast confirmation of something already true.
	const handleChooseLocal = useCallback(() => {
		if (localChecking) {
			return;
		}
		setLocalChecking(true);
		(async () => {
			const nodes = useNodeStore.getState().nodes;
			const node = nodes.find(isLocalNode) ?? LOCAL_FALLBACK;
			const { online } = await invoke<{ online: boolean }>("test_node", {
				name: node.name,
			}).catch(() => ({ online: false }));
			if (cancelledRef.current) {
				return;
			}
			setLocalChecking(false);
			if (!online) {
				setLocalUnreachable(true);
				return;
			}
			setLocalUnreachable(false);
			// Point the app at the node we just verified, so the rest of onboarding
			// and the app itself talk to it rather than a stale cloud default.
			await setDefault(node.name).catch(() => undefined);
			await beginLocalSetup(node).catch(() => undefined);
		})().catch(() => {
			if (!cancelledRef.current) {
				setLocalChecking(false);
				setLocalUnreachable(true);
			}
		});
	}, [beginLocalSetup, localChecking, setDefault]);

	// The only in-product path to a local node: the desktop app hosts it.
	const handleDownloadDesktop = useCallback(() => {
		openExternal(`${WEB_URL}/download`).catch(() => undefined);
	}, []);

	// Managed (Ryu Cloud) pick. Gated on the plan entitlement: if not entitled
	// (or the plan is still resolving to not-entitled) this is an upsell that
	// deep-links to web pricing and stays on the choice screen. When entitled it
	// adopts an already-provisioned org node (never provisions from the desktop):
	// poll the control plane briefly, then set it as the active node; if none
	// exists yet, deep-link to the org servers page and continue on local so the
	// user is never stranded waiting on a server to come up.
	const handleChooseManaged = useCallback(async () => {
		if (!entitlement?.managedInference) {
			openExternal(`${WEB_URL}/pricing`).catch(() => undefined);
			return;
		}
		if (managedBusy) {
			return;
		}
		setManagedBusy(true);
		const adopted = await adoptManagedNode(
			hydrateCloudNodes,
			() => cancelledRef.current
		);
		if (cancelledRef.current) {
			return;
		}
		setManagedBusy(false);

		if (adopted) {
			// Managed/cloud nodes live in memory only (never in nodes.json), so the
			// Rust set_default_node rejects their name. Try the persisted path for
			// parity, then fall back to an in-memory default so chat routes to the
			// adopted node this session.
			try {
				await setDefault(adopted.name);
			} catch {
				useNodeStore.setState({ defaultNode: adopted.name });
			}
			// A managed node runs its own inference; skip local CLI-agent detection
			// and go straight to the feature wizard.
			goToFeatures([]);
			return;
		}

		// Entitled, but no node is provisioned yet. Provisioning is web + webhook
		// driven (never from the desktop), so point them at the org servers page
		// and continue on local so onboarding still completes.
		sileo.success({
			title: "Provisioning continues on the web",
			description:
				"Buy or start a Ryu Cloud server in your browser. It appears here once it registers.",
		});
		openExternal(`${WEB_URL}/organizations`).catch(() => undefined);
		// Continue on local so onboarding still completes. Same explicit local-node
		// resolution as the local pick — `getActiveNode()` here could be the cloud
		// node we just failed to adopt.
		beginLocalSetup(
			useNodeStore.getState().nodes.find(isLocalNode) ?? LOCAL_FALLBACK
		).catch(() => undefined);
	}, [
		entitlement,
		managedBusy,
		hydrateCloudNodes,
		setDefault,
		goToFeatures,
		beginLocalSetup,
	]);

	// Cycle the status copy while a long auto-advancing phase is on screen so the
	// view never looks frozen. Resets to the first line whenever the phase flips,
	// and tears the interval down on any phase the map doesn't cover.
	useEffect(() => {
		const messages = ROTATING_MESSAGES[phase];
		if (!messages) {
			return;
		}
		setRotateIndex(0);
		const id = setInterval(() => {
			setRotateIndex((i) => (i + 1) % messages.length);
		}, ROTATE_INTERVAL_MS);
		return () => clearInterval(id);
	}, [phase]);

	// When Ryu never comes up (App.tsx flips it to "stopped" after its startup
	// timeout) the onboarding effect above never fires, so the screen would
	// otherwise sit forever on "starting" with a shimmering progress bar and no
	// way out. We render a dedicated error state with a restart button instead.
	const coreFailed = coreStatus === "stopped";
	const statusMessage =
		ROTATING_MESSAGES[phase]?.[rotateIndex] ?? STATUS_MESSAGES[phase];

	// Restart the whole app so it re-attempts startup from scratch; fall back to a
	// plain reload if the Tauri process plugin isn't reachable.
	const handleRestart = useCallback(async () => {
		try {
			const { relaunch } = await import("@tauri-apps/plugin-process");
			await relaunch();
		} catch {
			window.location.reload();
		}
	}, []);

	const toggle = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const handleContinue = useCallback(() => {
		goToFeatures(Array.from(selected));
	}, [goToFeatures, selected]);

	// Finish from the mic step (either "Continue" after enabling, or "Skip").
	const handleFinish = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		finish(target, pendingAgents);
	}, [submitting, getActiveNode, finish, pendingAgents]);

	if (coreFailed) {
		return (
			<div
				className="flex size-full flex-col items-center justify-center gap-6 p-8"
				data-tauri-drag-region="true"
			>
				<div className="max-w-md space-y-2 text-center">
					<p className="font-medium text-foreground text-xl">
						Couldn't start Ryu
					</p>
					<p className="text-muted-foreground text-sm">
						Something stopped Ryu from starting up. Restarting the app usually
						fixes it.
					</p>
				</div>
				<Button onClick={handleRestart} size="sm">
					Restart Ryu
				</Button>
			</div>
		);
	}

	return (
		<div className="size-full" data-tauri-drag-region="true">
			<OnboardingView
				agents={foundAgents.map(withAgentLogo)}
				currentFeature={TOGGLEABLE_FEATURES[featureIndex]}
				featureStepIndex={featureIndex + 1}
				featureStepTotal={TOGGLEABLE_FEATURES.length}
				localChecking={localChecking}
				localUnreachable={localUnreachable}
				managedBusy={managedBusy}
				managedEntitled={Boolean(entitlement?.managedInference)}
				managedLoading={entitlementLoading}
				micPrompt={<MicPermissionPrompt />}
				micSubmitting={submitting}
				onChooseLocal={handleChooseLocal}
				onChooseManaged={handleChooseManaged}
				onContinueAgents={handleContinue}
				onContinueMic={handleFinish}
				onDownloadDesktop={handleDownloadDesktop}
				onEnableFeature={() => applyFeatureChoice(true)}
				onSkipAgents={() => goToFeatures([])}
				onSkipFeature={() => applyFeatureChoice(false)}
				onSkipMic={handleFinish}
				onToggleAgent={toggle}
				progress={PHASE_PROGRESS[phase]}
				selected={selected}
				statusMessage={statusMessage}
				step={phase}
				suggestedAgents={suggestedAgents.map(withAgentLogo)}
			/>
		</div>
	);
}
