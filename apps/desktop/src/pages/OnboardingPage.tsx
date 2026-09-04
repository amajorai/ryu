import { OnboardingView } from "@ryu/blocks/desktop/onboarding";
import { Button } from "@ryu/ui/components/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import {
	ensureCoreInstalled,
	getRyuStatus,
	openExternal,
	startRyuCore,
} from "@/lib/tauri-bridge.ts";
import { AcquisitionSourceStep } from "@/src/components/onboarding/AcquisitionSourceStep.tsx";
import { ActivationOfferStep } from "@/src/components/onboarding/ActivationOfferStep.tsx";
import { ActivationRecommendationsStep } from "@/src/components/onboarding/ActivationRecommendationsStep.tsx";
import { ActivationTaskStep } from "@/src/components/onboarding/ActivationTaskStep.tsx";
import { ActivationValueStep } from "@/src/components/onboarding/ActivationValueStep.tsx";
import { ColorStep } from "@/src/components/onboarding/ColorStep.tsx";
import { NodePersonalizationStep } from "@/src/components/onboarding/NodePersonalizationStep.tsx";
import {
	type OnboardingOrganization,
	type OnboardingSetupKind,
	OnboardingSetupStep,
	type OnboardingThreadGroup,
} from "@/src/components/onboarding/OnboardingSetupStep.tsx";
import { PreferencesStep } from "@/src/components/onboarding/PreferencesStep.tsx";
import { PrivacyStep } from "@/src/components/onboarding/PrivacyStep.tsx";
import { SafetyPostureStep } from "@/src/components/onboarding/SafetyPostureStep.tsx";
import { TelegramOnboardingStep } from "@/src/components/onboarding/TelegramOnboardingStep.tsx";
import { UpdateStep } from "@/src/components/onboarding/UpdateStep.tsx";
import { WelcomeStep } from "@/src/components/onboarding/WelcomeStep.tsx";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useAutoImportThreads } from "@/src/hooks/useAutoImportThreads.ts";
import { useCreditsWallet } from "@/src/hooks/useCreditsWallet.ts";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import { buildSuggestedAgentInput } from "@/src/lib/agent-suggestion.ts";
import { track } from "@/src/lib/analytics.ts";
import {
	importAgentThread,
	listAgentThreads,
} from "@/src/lib/api/agent-threads.ts";
import {
	type AgentCatalogEntry,
	createAgent,
	fetchAgentCatalog,
	fetchAgents,
	installAgent,
} from "@/src/lib/api/agents.ts";
import {
	CheckoutError,
	createCheckout,
	fetchEntitlementStatus,
} from "@/src/lib/api/billing.ts";
import { type ChannelConfig, listChannels } from "@/src/lib/api/channels.ts";
import { ApiError, type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	type ComposioConnection,
	type ComposioToolkit,
	fetchComposioConnectionStatus,
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
	initiateComposioConnection,
} from "@/src/lib/api/composio.ts";
import {
	claimActivationReward,
	fetchActivationRewardSummary,
	saveOnboardingSource,
} from "@/src/lib/api/onboarding-activation.ts";
import {
	cancelProfileJob,
	continueProfileJobInBackground,
	fetchGatewayOnboardingAccess,
	fetchProfileAvailability,
	getProfileJobStatus,
	type NodeOnboardingSnapshot,
	type NodeSetupKind,
	type OnboardingAgentSuggestion,
	type ProfileJobStatus,
	type SaveNodeOnboardingStateInput,
	saveNodeOnboardingState,
	startProfileJob,
} from "@/src/lib/api/onboarding-profile.ts";
import {
	getActiveOrgId,
	listOrgs,
	type OrgListEntry,
	setActiveOrg,
} from "@/src/lib/api/orgs.ts";
import {
	configureProvider,
	fetchPiCatalog,
	type PiProvider,
} from "@/src/lib/api/pi-config.ts";
import {
	type AgentSelection,
	DEFAULT_USER_PERSONALIZATION,
	defaultCloudAgentSelection,
	defaultLocalAgentSelection,
	EMPTY_AGENT_SELECTION,
	getLaneAgentSelection,
	getPreference,
	setLaneAgentSelection,
	setPreference,
	USER_PERSONALIZATION_PREF_KEY,
	type UserPersonalization,
} from "@/src/lib/api/preferences.ts";
import { createQuest } from "@/src/lib/api/quests.ts";
import { checkoutTeamsOnboarding } from "@/src/lib/api/teams-billing.ts";
// # 0.1.0: Island disabled — uncomment with the onboarding install below
// import { installAndLaunchIsland } from "@/src/lib/api/island.ts";
import { ensureMicPermission } from "@/src/lib/audio/devices.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import { triggerAgentsRefresh } from "@/src/lib/core-refresh.ts";
import {
	isDesktopOnboardingComplete,
	markDesktopOnboardingComplete,
} from "@/src/lib/desktop-onboarding-state.ts";
import { setFeatureEnabled, TOGGLEABLE_FEATURES } from "@/src/lib/features.ts";
import { useEntityCap } from "@/src/lib/gating/useEntityCap.ts";
import {
	type InstallerProgress,
	installerComponentLabel,
} from "@/src/lib/installer-progress.ts";
import {
	type ActivationRecommendation,
	activationRewardProgress,
	buildActivationRecommendations,
	buildActivationTaskDraft,
	deriveActivationEligibility,
} from "@/src/lib/onboarding-activation.ts";
import { setOnboardingActive } from "@/src/lib/onboarding-active.ts";
import {
	buildOnboardingTaskRouteState,
	ONBOARDING_CHAT_ROUTE_STATE,
} from "@/src/lib/onboarding-navigation.ts";
import { fetchCatalog, installSidecar } from "@/src/lib/services-api.ts";
import { isTauriReady, listenWhenReady } from "@/src/lib/tauri-ready.ts";
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

// The 'agents', 'features', 'mic', 'theme', 'preferences', 'privacy', and 'welcome' phases
// are interactive: the user picks which extra agents to add, optionally enables
// the microphone, sets the look, tunes a few general + privacy settings, and
// acknowledges the final welcome screen.
// Every other phase auto-advances.
type Phase =
	| "starting"
	| "updates"
	| "choose"
	| "connect"
	| "installing"
	| "agents"
	| "node-setup"
	| "local-default"
	| "organization"
	| "providers"
	| "connections"
	| "cloud-default"
	| "imports"
	| "profile"
	| "agent-suggestions"
	| "telegram"
	| "features"
	| "mic"
	| "theme"
	| "safety"
	| "preferences"
	| "privacy"
	| "welcome"
	| "activation-source"
	| "activation-apps"
	| "activation-value"
	| "activation-offer"
	| "activation-task"
	| "finishing"
	| "done";

const PHASE_TITLES: Partial<Record<Phase, string>> = {
	updates: "Before we get started",
	choose: "Where should Ryu do the work?",
	connect: "Connect the place where work runs",
	agents: "Choose what you want to run",
	"node-setup": "Set up this node",
	"local-default": "Choose your local starting point",
	organization: "Choose the workspace you work in",
	providers: "Choose how cloud work connects",
	connections: "Connect the tools behind your work",
	"cloud-default": "Choose your cloud starting point",
	imports: "Bring your work with you",
	profile: "Give Ryu a starting point",
	"agent-suggestions": "Suggested agents for your work",
	telegram: "Take the work to Telegram",
	features: "Choose what Ryu can do",
	mic: "Choose how you talk to Ryu",
	// The theme/preferences/privacy steps render their own headers; these entries
	// only satisfy the map.
	theme: "Make it yours",
	safety: "Choose your workflow autonomy",
	preferences: "Set your preferences",
	privacy: "Your privacy",
	welcome: "Your workspace is ready",
	done: "Ready to finish real work",
};

const PHASE_SUBTITLES: Partial<Record<Phase, string>> = {
	choose:
		"Want the easiest setup? Start with Ryu Cloud. You can also run Ryu here or use a server your team already has.",
	connect: "Use an existing Ryu node as the place your work runs",
	agents: "Start with one capability; add more when a workflow needs it",
	"node-setup":
		"Choose whether this node is for private work or a shared team workspace",
	"local-default":
		"This is the default lane for local work, plugins, and offline fallback",
	organization: "Choose the shared workspace that owns your work and access",
	providers:
		"Optional: connect a provider for cloud work. Keys stay on this node.",
	connections: "Connect the accounts Ryu will use, then review each permission",
	"cloud-default": "Normal chats use this lane when it is configured",
	imports: "Bring existing conversations into the workspace",
	profile:
		"Give Ryu a starting point; approve the result before it becomes your profile",
	"agent-suggestions":
		"Review focused agent drafts from the workflows Ryu found in your approved sources",
	telegram: "Use the same default agent from Telegram",
	features: "Turn capabilities on or off; change them later",
	mic: "Talk to Ryu when typing is not the fastest way",
	safety: "Choose how much autonomy each workflow can have",
	welcome: "Ready when you are",
	done: "Ready to finish real work",
};

interface OnboardingPageProps {
	nodeOnboardingState: NodeOnboardingSnapshot | null;
	nodeOnboardingStateAvailable: boolean;
}

function initialPhaseForOnboarding({
	desktopPending,
	nodePending,
}: {
	desktopPending: boolean;
	nodePending: boolean;
}): Phase {
	if (nodePending && !desktopPending) {
		return "node-setup";
	}
	if (!nodePending && desktopPending) {
		return "mic";
	}
	return isTauriReady() ? "updates" : "starting";
}

// The auto-advancing phases (`starting`/`installing`/`finishing`) can sit for a
// long time — `waitForLocalStack` polls the bundled inference install for up to
// 30 minutes. A single frozen line reads as "nothing is happening", so on those
// phases we cycle the header line to make the wait feel alive.
const ROTATING_SUBTITLES: Partial<Record<Phase, string[]>> = {
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
// Every Core request onboarding makes carries this. `fetch` has no default
// timeout, so one unanswered request is enough to freeze a whole phase — which
// is exactly how the setup screen used to hang with no way out.
const REQUEST_TIMEOUT_MS = 15 * 1000;
// The agent catalog gets a longer one: Core spawns a `--version` probe per agent
// (and an npm lookup per bridge), each bounded at 30s on its side.
const AGENT_CATALOG_TIMEOUT_MS = 60 * 1000;
// How long onboarding will sit on the "installing" screen waiting for the local
// inference stack. A fast (cached) install finishes well inside this and the user
// lands ready. But the install is a sizable model/binary download that can run
// for many minutes — and on macOS it sometimes stays in `installing` for a long
// time — so we never hold the user hostage past this budget: the install keeps
// running in the background and the Models / Getting-Started surfaces track the
// rest. Better to drop them into the app than to freeze the setup screen.
const MAX_BLOCK_MS = 45 * 1000;
// How long the mic step waits on the OS permission dialog before moving on.
const MIC_PROMPT_MAX_MS = 30 * 1000;
const LOCAL_STACK = "llamacpp";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Was this failure "you are not authenticated" rather than a transient network
 * blip? Two shapes reach here: the typed {@link ApiError} the node client throws
 * (`status`), and `services-api`'s plain `Error("catalog fetch failed: 401")`.
 * Worth distinguishing because a 401 never heals by retrying with the same
 * credential — it means the token is missing, which on a first run it is.
 */
function isUnauthorized(err: unknown): boolean {
	if (err instanceof ApiError) {
		return err.status === 401;
	}
	return err instanceof Error && /\b401\b/.test(err.message);
}

/**
 * Re-read the node store from disk and hand back the LOCAL node as it stands
 * right now.
 *
 * Why this exists rather than a plain `nodes.find(isLocalNode)`: Core mints
 * `~/.ryu/node-auth.token` on its FIRST boot, and the desktop only attaches that
 * token to the local node inside the Tauri `list_nodes` command
 * (`nodes.rs::fill_local_token`) — i.e. at store-load time. On a first run the
 * store hydrates at app boot, long before onboarding's "run locally" pick has
 * started a Core, so the local node it holds carries `token: null`. Every Core
 * call made with that captured object then 401s (`require_auth` rejects a
 * tokenless `/api/*` since the node-token work landed), which silently emptied
 * the agent catalog and made the "Add your agents" step look deleted.
 *
 * So: never capture the local node before Core has booted. Call this after, and
 * again per leg, so a token minted mid-flow is picked up.
 */
async function refreshLocalNode(): Promise<Node> {
	try {
		await useNodeStore.getState().refresh();
	} catch {
		// Not in Tauri, or the store command failed — fall through to whatever the
		// store already holds rather than failing the whole pick.
	}
	return useNodeStore.getState().nodes.find(isLocalNode) ?? LOCAL_FALLBACK;
}

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
	isCancelled: () => boolean,
	report: LocalStatusReporter
): Promise<void> {
	const poll = async () => {
		const deadline = Date.now() + MAX_BLOCK_MS;
		let triggered = false;
		// The credential this loop authenticates with. Mutable because Core may
		// have minted the node token only moments ago (first run): if a poll comes
		// back 401 we re-read it once rather than spending the whole 45s budget on
		// requests that can never succeed — which is what made the local pick look
		// like it stalled and then skipped the agents step.
		let auth = node.token ?? null;
		let reauthed = false;
		while (Date.now() < deadline && !isCancelled()) {
			try {
				const catalog = await fetchCatalog(
					node.url,
					auth,
					AbortSignal.timeout(REQUEST_TIMEOUT_MS)
				);
				const entry = catalog.find((c) => c.name === LOCAL_STACK);
				if (entry?.installState === "installed") {
					report.done("Local AI engine ready");
					report.status(null);
					return;
				}
				if (entry?.installState === "failed") {
					report.status(null);
					return;
				}
				if (entry?.installState === "installing") {
					report.status("Installing the local AI engine…", STAGE_ENGINE);
				}
				// Nothing has started the install (macOS path) — start it once, then
				// keep polling. Best-effort: a failed kick just leaves us polling.
				if (!triggered && entry?.installState === "not_installed") {
					triggered = true;
					report.status("Installing the local AI engine…", STAGE_ENGINE);
					await installSidecar(
						node.url,
						auth,
						LOCAL_STACK,
						false,
						AbortSignal.timeout(REQUEST_TIMEOUT_MS)
					).catch(() => undefined);
				}
			} catch (err) {
				// A 401 is not transient — it means we are holding the wrong (or no)
				// credential, and every remaining poll would fail identically. Re-read
				// the node once; only then fall back to "keep polling".
				if (isUnauthorized(err) && !reauthed) {
					reauthed = true;
					auth = (await refreshLocalNode()).token;
				}
				// Otherwise keep polling on transient network errors.
			}
			await sleep(POLL_INTERVAL_MS);
			if (isCancelled()) {
				return;
			}
		}
	};
	// The `Date.now() < deadline` check only runs BETWEEN iterations, so a single
	// request that never settles used to pin this phase forever — the 45s budget
	// was never enforced. Every request inside now carries its own timeout, and
	// this race is the belt-and-braces: the budget is honoured even if one does
	// not. The install keeps running in the background either way.
	await Promise.race([poll(), sleep(MAX_BLOCK_MS)]);
	// Grace budget elapsed and the stack is still installing — proceed anyway and
	// let it finish in the background rather than stranding the user here.
}

// How long the "run locally" pick waits for a Core it just installed/started to
// answer its health check. Generous because the first run may be downloading the
// binary; past this we surface the failure on the choose step rather than
// dropping the user into an app with no backend.
const CORE_BOOT_MAX_MS = 5 * 60 * 1000;
const CORE_BOOT_POLL_MS = 1500;
// After this much of the boot wait, the status admits the wait is long rather
// than repeating "Starting Ryu…" for another four minutes.
const CORE_BOOT_SLOW_MS = 45 * 1000;
// A typed node address gets one short probe — long enough for a LAN round trip,
// short enough that a wrong address fails fast.
const CONNECT_PROBE_TIMEOUT_MS = 6000;

/**
 * Bring a local Core up for the "run locally" pick: install the binary if it is
 * missing (a no-op in dev and when it is already there), start it, then poll
 * health until it answers. Resolves true once Core is running.
 *
 * This is the moment the desktop earns the right to install anything. The app
 * itself opens with no Core at all — a user who connects to their team's node
 * never downloads one — so the install is deferred to the explicit local pick
 * rather than run at boot.
 */
async function startLocalCore(
	isCancelled: () => boolean,
	report: LocalStatusReporter
): Promise<{ error?: string; ok: boolean }> {
	const onStatus = report.status;
	if ((await getRyuStatus().catch(() => "stopped")) === "running") {
		onStatus(null, null);
		return { ok: true };
	}
	onStatus("Getting Ryu ready…", STAGE_PREPARING);
	// A download failure still leaves an older binary usable, so this is not fatal
	// on its own — but it must not be SWALLOWED either. Both halves used to be
	// `.catch(() => undefined)`, so a 404 on the release asset (or a full disk)
	// bought five silent minutes of polling for a binary that was never on disk,
	// and then a generic "couldn't start" card that named nothing.
	const installError = await ensureCoreInstalled().then(
		() => null,
		(err: unknown) => (err instanceof Error ? err.message : String(err))
	);
	if (isCancelled()) {
		return { ok: false };
	}
	const startError = await startRyuCore().then(
		() => null,
		(err: unknown) => (err instanceof Error ? err.message : String(err))
	);
	// Nothing to wait for: the install failed AND the spawn found no binary to
	// run. Report the install error (the useful one) immediately instead of
	// burning the whole boot budget.
	if (installError !== null && startError !== null) {
		return { error: installError, ok: false };
	}

	// The download is over but the pick is not: Core still has to boot and answer
	// its health check, which is up to CORE_BOOT_MAX_MS. The installer stops
	// emitting at `done`, so without a status of our own the card would revert to
	// its marketing copy and sit there for five minutes — the same "nothing is
	// happening" shape, just moved past the download.
	const started = Date.now();
	const deadline = started + CORE_BOOT_MAX_MS;
	onStatus("Starting Ryu…", STAGE_BOOTING);
	while (Date.now() < deadline && !isCancelled()) {
		if ((await getRyuStatus().catch(() => "stopped")) === "running") {
			report.done("Ryu is running");
			onStatus(null, null);
			return { ok: true };
		}
		if (Date.now() - started > CORE_BOOT_SLOW_MS) {
			onStatus(
				"Still starting, the first launch takes a little longer…",
				STAGE_BOOTING
			);
		}
		await sleep(CORE_BOOT_POLL_MS);
	}
	onStatus(null, null);
	// Health never answered. `startError` is null on the common shape of this
	// failure (the spawn succeeded, Core died or hung on boot), so say what we
	// actually observed rather than handing the card an empty detail line.
	return {
		error:
			startError ??
			`Ryu Core was started but never answered its health check within ${Math.round(
				CORE_BOOT_MAX_MS / 60_000
			)} minutes.`,
		ok: false,
	};
}

/** The stages the installer events cannot see — Core booting, the local engine
 *  install, and agent detection. A fixed position keeps the bar honest across
 *  the whole local setup flow. */
// The stages either side of the installer range have no measurable fraction of
// their own. They bracket the script's structured progress: prepare → install →
// boot → local-stack wait.
const STAGE_PREPARING = 8;
const STAGE_BOOTING = 58;
const STAGE_ENGINE = 70;
const STAGE_AGENTS = 82;

/** How the async local bring-up talks to the screen: `status` is what is
 *  happening now (null retires the line), `done` records something finished so it
 *  keeps its turn in the rotation afterwards. */
interface LocalStatusReporter {
	done: (line: string) => void;
	status: (line: string | null, percent?: number | null) => void;
}

/** Normalize a typed node address: trim, add a scheme if omitted, drop the
 *  trailing slash. `192.168.1.20:7980` and `http://192.168.1.20:7980/` both
 *  resolve to the same URL the node store stores. */
function normalizeNodeUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (trimmed === "") {
		return "";
	}
	return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Probe a node the user just typed. Unlike `test_node` this takes a URL rather
 *  than the name of an already-persisted node — nothing is written to nodes.json
 *  until this passes. */
async function probeNodeUrl(url: string, token: string): Promise<boolean> {
	const headers: Record<string, string> = {};
	if (token !== "") {
		headers.Authorization = `Bearer ${token}`;
	}
	try {
		const res = await fetch(`${url}/api/health`, {
			headers,
			signal: AbortSignal.timeout(CONNECT_PROBE_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** A stable, human-readable name for a connected node, derived from its host and
 *  de-duplicated against the names already in the store. */
function nodeNameForUrl(url: string, taken: readonly string[]): string {
	let base: string;
	try {
		base = new URL(url).hostname || "node";
	} catch {
		base = "node";
	}
	if (!taken.includes(base)) {
		return base;
	}
	let n = 2;
	while (taken.includes(`${base}-${n}`)) {
		n++;
	}
	return `${base}-${n}`;
}

// The curated set of third-party agents worth surfacing on first run. Anything
// detectable but not on this list is too niche for onboarding and is hidden.
// Ids are matched against the live catalog and the live row wins whenever there
// is one — it carries the description, icon and `detected`/`added` flags. But a
// curated agent the catalog does NOT mention still renders, from the static row
// below (see the union in `loadOnboardingAgents`). This list is curation, and the
// catalog is a remote-registry fetch that can come back partial or not at all;
// letting that decide what onboarding offers is what made "Add your agents" show
// up empty on a machine with no agents installed — exactly the machine that needs
// the suggestions most.
const SUGGESTED_AGENTS: readonly {
	id: string;
	name: string;
	registryId: string | null;
}[] = [
	{ id: "acp:claude", name: "Claude Code", registryId: "claude-acp" },
	{ id: "acp:codex", name: "Codex", registryId: "codex-acp" },
	{ id: "acp:cursor", name: "Cursor", registryId: "cursor" },
	{ id: "acp:gemini", name: "Gemini CLI", registryId: "gemini" },
	{ id: "acp:opencode", name: "opencode", registryId: "opencode" },
	{
		id: "acp:copilot",
		name: "GitHub Copilot CLI",
		registryId: "github-copilot-cli",
	},
	{ id: "acp:grok", name: "Grok CLI", registryId: "grok-build" },
	{ id: "acp:droid", name: "Factory Droid", registryId: "factory-droid" },
	{ id: "acp:qwen", name: "Qwen Code", registryId: "qwen-code" },
	{ id: "acp:goose", name: "Goose", registryId: "goose" },
	{ id: "acp:cline", name: "Cline", registryId: "cline" },
	{ id: "hermes", name: "Hermes", registryId: null },
	{ id: "openclaw", name: "OpenClaw", registryId: null },
	{ id: "acp:prime", name: "Prime Agent", registryId: null },
	{ id: "acp:openhands", name: "OpenHands", registryId: null },
	{ id: "acp:blackbox", name: "Blackbox CLI", registryId: null },
	{ id: "acp:code-assistant", name: "Code Assistant", registryId: null },
	{ id: "acp:construct", name: "Construct", registryId: null },
	{ id: "acp:bub", name: "Bub", registryId: null },
	{ id: "acp:raxol", name: "Raxol", registryId: null },
	{ id: "acp:localharness", name: "localharness", registryId: null },
	{ id: "acp:kaagum", name: "Kaagum", registryId: null },
	{ id: "acp:docker-agent", name: "Docker Agent", registryId: null },
	{ id: "acp:agentpool", name: "AgentPool", registryId: null },
];

/**
 * The curated rows rendered when the catalog could not be reached — the same
 * agents, minus the live `detected`/`added` flags Core would have filled in.
 * The logo resolver keys off `id`/`engine`/`registryId`, all of which are known
 * statically, so these rows look identical to the live ones.
 */
function fallbackSuggestedAgents(): AgentCatalogEntry[] {
	return SUGGESTED_AGENTS.map(staticSuggestedAgent);
}

/** One curated agent as a catalog row, with the live flags Core would have filled
 *  in left blank. Split out of {@link fallbackSuggestedAgents} because the merge in
 *  {@link loadOnboardingAgents} needs a single row, not the whole list. */
function staticSuggestedAgent(a: {
	id: string;
	name: string;
	registryId: string | null;
}): AgentCatalogEntry {
	return {
		added: false,
		available: true,
		bridgeVersionStatus: null,
		description: null,
		detected: null,
		engine: null,
		gatewayBypass: false,
		iconUrl: null,
		id: a.id,
		installedBridgeVersion: null,
		installedVersion: null,
		installHint: null,
		latestBridgeVersion: null,
		latestVersion: null,
		name: a.name,
		recommended: false,
		registryId: a.registryId,
		transport: null,
		versionStatus: null,
	};
}

interface OnboardingAgents {
	/** Agents detected on the user's PATH — shown first, pre-selected. */
	found: AgentCatalogEntry[];
	/**
	 * False when the catalog call FAILED (401, timeout, node down) rather than
	 * genuinely returning nothing. The distinction is the whole bug: the two were
	 * conflated, so an unreachable Core read as "no agents to offer" and the step
	 * was dropped from the flow with no error, no toast and no log.
	 */
	ok: boolean;
	/** Curated popular agents not already present — opt-in, not pre-selected. */
	suggested: AgentCatalogEntry[];
}

/**
 * Split the agent catalog into the two onboarding buckets: agents already found
 * on the system, and the curated "suggested" set the user can opt into. Ryu and
 * already-added agents are excluded from both.
 *
 * On failure this returns `ok: false` WITH the static curated set, so the step
 * still has something to render. Callers must never treat a failure as a reason
 * to skip the step — a network error must not delete a step from a wizard.
 */
async function loadOnboardingAgents(
	target: ApiTarget
): Promise<OnboardingAgents> {
	try {
		// `versions: false` is what makes this step reliable rather than merely
		// bounded. The versioned catalog does an npm-registry lookup per agent
		// (~30s warm, unbounded cold), so the timeout below was routinely the thing
		// that decided whether the step appeared: one slow network and BOTH buckets
		// came back empty, the caller skipped straight to the next phase, and the
		// agent step looked deleted. Detection needs none of that work — it is a
		// PATH check — so onboarding asks for exactly the two flags it reads.
		const agents = await fetchAgentCatalog(
			target,
			AbortSignal.timeout(AGENT_CATALOG_TIMEOUT_MS),
			{ versions: false }
		);
		const installable = agents.filter((a) => a.id !== "ryu" && !a.added);
		const found = installable.filter((a) => a.detected === true);
		// Curation UNION catalog, not curation filtered BY it. The catalog's agent
		// list is fetched from the remote ACP registry and cached; when that fetch
		// fails or times out on a cold start Core says so and serves a partial list
		// (see `ensure_registry_cached`). Intersecting against it therefore deleted
		// well-known agents from the step for a reason that has nothing to do with
		// this machine — and on a system where nothing is detected, that left the
		// user staring at "Add your agents" with nothing to add.
		//
		// A live row always wins (it carries `detected`/`added`/description/icon);
		// a curated agent the catalog does not mention falls back to its static row
		// so the offer is at least present. Installing one of those may fail, which
		// is fine: `finish` adds agents with `allSettled` precisely because an add is
		// best-effort, and a row that fails to install beats a row that never appears.
		const suggested = SUGGESTED_AGENTS.map((curated) => {
			const live = installable.find((a) => a.id === curated.id);
			if (live) {
				return live.detected === true ? undefined : live;
			}
			// Absent from `installable` because it is already added, or because the
			// catalog never listed it. Only the second case earns a fallback row.
			return agents.some((a) => a.id === curated.id)
				? undefined
				: staticSuggestedAgent(curated);
		}).filter((a): a is AgentCatalogEntry => a !== undefined);
		return { found, ok: true, suggested };
	} catch (err) {
		// Never silent: this exact swallow is how a 401 turned into a missing step.
		track({
			event: "onboarding_agent_catalog_failed",
			reason: failReason(err),
		});
		return { found: [], ok: false, suggested: fallbackSuggestedAgents() };
	}
}

/** Why the catalog call failed, as one of the analytics enum's literals. */
function failReason(err: unknown): "unauthorized" | "timeout" | "unreachable" {
	if (isUnauthorized(err)) {
		return "unauthorized";
	}
	if (
		err instanceof Error &&
		(err.name === "TimeoutError" || /timed? ?out/i.test(err.message))
	) {
		return "timeout";
	}
	return "unreachable";
}

export default function OnboardingPage({
	nodeOnboardingState: initialNodeOnboardingState,
	nodeOnboardingStateAvailable,
}: OnboardingPageProps) {
	const { isDesktop } = useAppSurface();
	const navigate = useNavigate();
	const stepUp = useStepUp();
	const coreStatus = useAppStore((s) => s.coreStatus);
	const { getActiveNode, hydrateCloudNodes, setDefault, updateNodeToken } =
		useNodeStore();
	// The exact entitlement read NodeSelector's managed surfaces use (WS8): gates
	// the managed (Ryu Cloud) option on the plan's managed-inference flag.
	const {
		entitlement,
		loading: entitlementLoading,
		refresh: refreshCredits,
	} = useCreditsWallet();
	const { guard: guardAgentCreation } = useEntityCap();
	const desktopOnboardingPending = !isDesktopOnboardingComplete();
	const [nodeOnboardingState, setNodeOnboardingState] = useState(
		initialNodeOnboardingState
	);
	const nodeOnboardingPending =
		nodeOnboardingStateAvailable &&
		nodeOnboardingState?.canConfigure !== false &&
		nodeOnboardingState?.completed !== true;
	// The browser builds reuse this page, but a browser deployment is not a
	// desktop bundle and must not present a native-app update verdict. In Tauri,
	// the update check is the first screen after device auth succeeds.
	const [phase, setPhase] = useState<Phase>(() =>
		initialPhaseForOnboarding({
			desktopPending: desktopOnboardingPending,
			nodePending: nodeOnboardingPending,
		})
	);
	// The line currently on screen for an auto-advancing phase. It is set by the
	// rotation tick below, which alternates the flavour copy with whatever is
	// REALLY happening, so the loop is never pure theatre.
	const [loopLine, setLoopLine] = useState<string | null>(null);
	// Managed adoption is polling the control plane for a provisioned node.
	const [managedBusy, setManagedBusy] = useState(false);
	// Webapp-only: the local reachability probe behind the "local" pick. The
	// desktop gates the whole `choose` step on its own Core already running, but
	// the webapp's `get_ryu_status` reports the HOSTED core, so `choose` renders
	// even with nothing on 127.0.0.1 — picking local there used to burn the 45s
	// waitForLocalStack budget and then drop the user into a broken app.
	const [localChecking, setLocalChecking] = useState(false);
	const [localUnreachable, setLocalUnreachable] = useState(false);
	// Why the local pick failed, in Core's own words ("HTTP 404" on a missing
	// release asset, a write error, …). The card used to say only "something went
	// wrong", which is unactionable for the one path that installs software.
	const [localError, setLocalError] = useState<string | null>(null);
	// What the local bring-up is doing RIGHT NOW ("Installing the model gateway"),
	// and the things it has already finished ("Ryu Core installed"). Refs, not
	// state: installer events can arrive frequently and the rotation tick samples
	// them, while the progress bar tracks the script's structured percentage live.
	const liveStatusRef = useRef<string | null>(null);
	const doneStatusRef = useRef<string[]>([]);
	const [localPercent, setLocalPercent] = useState<number | null>(null);
	const updateLocalPercent = useCallback((percent: number | null) => {
		if (percent === null) {
			setLocalPercent(null);
			return;
		}
		setLocalPercent((previous) =>
			previous === null ? percent : Math.max(previous, percent)
		);
	}, []);
	// Which path the user picked on `choose`, or null while they are still on the
	// fork. Only the local path cares whether this device's Core came up, so this
	// is what gates the "Couldn't start Ryu" screen — a user on a remote or cloud
	// node must never be blocked by a Core they deliberately did not install.
	const [mode, setMode] = useState<"local" | "managed" | "remote" | null>(null);
	// The connect-to-an-existing-node form: probe in flight, and why the last
	// attempt failed.
	const [remoteChecking, setRemoteChecking] = useState(false);
	const [remoteError, setRemoteError] = useState<string | null>(null);
	// Guards the async local/managed setup against a late state update after the
	// page unmounts (it unmounts when the first Ryu chat tab opens).
	const cancelledRef = useRef(false);
	useEffect(() => {
		cancelledRef.current = false;
		return () => {
			cancelledRef.current = true;
		};
	}, []);

	const activateOnboardingNode = useCallback(
		async (node: Node): Promise<Node> => {
			try {
				await setDefault(node.name);
			} catch {
				// Browser onboarding has no Tauri persistence bridge. Keep the selected
				// node active for this session instead of continuing against a stale
				// cloud/default node.
				useNodeStore.setState({
					activeNodeOnline: null,
					autoSelectedNode: null,
					defaultNode: node.name,
				});
			}
			// A deliberate onboarding choice must win over any stale auto-selection.
			useNodeStore.setState({ autoSelectedNode: null, activeNodeOnline: null });
			const active = useNodeStore.getState().getActiveNode();
			const sameUrl =
				active.url.replace(/\/+$/u, "") === node.url.replace(/\/+$/u, "");
			if (active.name !== node.name || !sameUrl) {
				throw new Error("Ryu could not activate the selected node. Try again.");
			}
			return active;
		},
		[setDefault]
	);

	// The stages the installer events cannot see — preparing, Core booting, the
	// local engine install, agent detection. A fixed bar position rather than a
	// fraction; null hands the bar back to the phase's own placeholder.
	const reportLocalStatus = useCallback(
		(status: string | null, percent?: number | null) => {
			liveStatusRef.current = status;
			updateLocalPercent(percent ?? null);
		},
		[updateLocalPercent]
	);

	/** Record something that has actually COMPLETED. These keep appearing in the
	 *  loop after the fact, which is the point: the gateway and the local engine
	 *  install silently today, so nothing on screen ever admitted they existed. */
	const reportDone = useCallback((line: string) => {
		const log = doneStatusRef.current;
		if (log.at(-1) !== line) {
			log.push(line);
		}
	}, []);

	/** The pair handed to every async leg of the local bring-up. */
	const localReport = useMemo<LocalStatusReporter>(
		() => ({ done: reportDone, status: reportLocalStatus }),
		[reportDone, reportLocalStatus]
	);

	// Claim the installer progress for the duration of the wizard. App.tsx listens
	// to the same stream outside onboarding and toasts it; here the wizard owns the
	// inline status and progress bar.
	useEffect(() => {
		setOnboardingActive(true);
		return () => setOnboardingActive(false);
	}, []);

	// Preserve a previously entered personal profile when node onboarding is
	// resumed. This preference is only written for the personal-node path; team
	// context stays in the node state and is visible to everyone on that node.
	useEffect(() => {
		if (!(nodeOnboardingStateAvailable && nodeOnboardingPending)) {
			return;
		}
		let cancelled = false;
		void getPreference(toTarget(getActiveNode()), USER_PERSONALIZATION_PREF_KEY)
			.then((raw) => {
				if (cancelled || !raw) {
					return;
				}
				try {
					const parsed = JSON.parse(raw) as Partial<UserPersonalization>;
					setUserPersonalization((current) => ({
						...current,
						...parsed,
					}));
				} catch {
					// Keep the empty defaults when an older client left corrupt data.
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [getActiveNode, nodeOnboardingPending, nodeOnboardingStateAvailable]);

	// Mirror the public installer's versioned progress envelope. The stream covers
	// Core, Gateway, CLI, Core boot, and the bundled defaults; agent detection and
	// the rest of Desktop onboarding remain local responsibilities.
	useEffect(() => {
		const unlisteners: (() => void)[] = [];
		listenWhenReady<InstallerProgress>("installer-progress", ({ payload }) => {
			const percent = payload.percent ?? null;
			if (payload.phase === "binary") {
				const label = installerComponentLabel(payload.component);
				if (payload.status === "started") {
					liveStatusRef.current = `Installing ${label}…`;
				} else if (
					payload.status === "complete" ||
					payload.status === "skipped"
				) {
					reportDone(`${label} installed`);
					liveStatusRef.current = null;
				}
				updateLocalPercent(percent);
			} else if (payload.phase === "core") {
				if (payload.status === "started") {
					liveStatusRef.current = "Starting Ryu Core…";
				} else if (payload.status === "complete") {
					reportDone("Ryu Core is healthy");
					liveStatusRef.current = null;
				}
				updateLocalPercent(percent);
			} else if (payload.phase === "defaults") {
				if (
					payload.component === "bundled-defaults" &&
					payload.status === "started"
				) {
					liveStatusRef.current =
						"Installing bundled models, engines, and skills…";
				} else if (
					payload.component === "bundled-defaults" &&
					payload.status === "skipped"
				) {
					liveStatusRef.current = null;
				}
				updateLocalPercent(percent);
			} else if (payload.phase === "bootstrap") {
				// `startLocalCore` still performs the Desktop health wait after the
				// script exits, so leave room for that phase before the local-stack
				// and agent steps take the bar to completion.
				updateLocalPercent(payload.status === "complete" ? 75 : percent);
			} else if (payload.phase === "error") {
				liveStatusRef.current = null;
			}
		}).then((fn) => unlisteners.push(fn));
		return () => {
			for (const fn of unlisteners) {
				fn();
			}
		};
	}, [reportDone, updateLocalPercent]);

	// Agents found on the user's system (pre-selected) and the curated suggested
	// set (opt-in). Only the flagship Ryu agent is installed by default.
	const [foundAgents, setFoundAgents] = useState<AgentCatalogEntry[]>([]);
	const [suggestedAgents, setSuggestedAgents] = useState<AgentCatalogEntry[]>(
		[]
	);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// The catalog call failed, so the rows on screen are the curated fallback and
	// "Found on your system" could not be computed. Drives an inline notice with a
	// Retry — the step is still shown, because a step is not a query result.
	const [agentsUnavailable, setAgentsUnavailable] = useState(false);
	// Which node the agents step is talking to, so Retry can re-ask the same one.
	const [agentsNode, setAgentsNode] = useState<Node | null>(null);
	const [agentsRetrying, setAgentsRetrying] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [nodeSetupKind, setNodeSetupKind] = useState<NodeSetupKind | null>(
		() => nodeOnboardingState?.setupKind ?? null
	);
	const [companyContext, setCompanyContext] = useState(
		() => nodeOnboardingState?.personalization.companyContext ?? ""
	);
	const [companyKnowledgeEnabled, setCompanyKnowledgeEnabled] = useState(() =>
		nodeOnboardingState?.setupKind === "team"
			? nodeOnboardingState.personalization.companyKnowledgeEnabled
			: true
	);
	const [userPersonalization, setUserPersonalization] =
		useState<UserPersonalization>(DEFAULT_USER_PERSONALIZATION);
	const [nodeSetupError, setNodeSetupError] = useState<string | null>(null);
	const lastExternalNodeState = useRef<
		NodeOnboardingSnapshot | null | undefined
	>(undefined);
	useEffect(() => {
		if (lastExternalNodeState.current === initialNodeOnboardingState) {
			return;
		}
		lastExternalNodeState.current = initialNodeOnboardingState;
		setNodeOnboardingState(initialNodeOnboardingState);
		setNodeSetupKind(initialNodeOnboardingState?.setupKind ?? null);
		setCompanyContext(
			initialNodeOnboardingState?.personalization.companyContext ?? ""
		);
		setCompanyKnowledgeEnabled(
			initialNodeOnboardingState?.setupKind === "team"
				? initialNodeOnboardingState.personalization.companyKnowledgeEnabled
				: true
		);
		setNodeSetupError(null);
	}, [initialNodeOnboardingState]);
	// Agents chosen on the picker, held while the later steps are shown.
	const [allowedAgentIds, setAllowedAgentIds] = useState<string[]>(["ryu"]);
	const [localSelection, setLocalSelection] = useState<AgentSelection>(
		EMPTY_AGENT_SELECTION
	);
	const [cloudSelection, setCloudSelection] = useState<AgentSelection>(
		EMPTY_AGENT_SELECTION
	);
	const [organizations, setOrganizations] = useState<OnboardingOrganization[]>(
		[]
	);
	const [selectedOrganizationId, setSelectedOrganizationId] = useState<
		string | null
	>(null);
	const [piProviders, setPiProviders] = useState<PiProvider[]>([]);
	const [configuredProviderIds, setConfiguredProviderIds] = useState<string[]>(
		[]
	);
	const [providerBusyId, setProviderBusyId] = useState<string | null>(null);
	const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
	const [connections, setConnections] = useState<ComposioConnection[]>([]);
	const [channelConfigs, setChannelConfigs] = useState<ChannelConfig[] | null>(
		null
	);
	const [connectionsCheckFailed, setConnectionsCheckFailed] = useState(false);
	const [gatewaySetupAllowed, setGatewaySetupAllowed] = useState(true);
	const [gatewayAccess, setGatewayAccess] = useState<Awaited<
		ReturnType<typeof fetchGatewayOnboardingAccess>
	> | null>(null);
	const [connectionQuery, setConnectionQuery] = useState("");
	const [connectingToolkit, setConnectingToolkit] = useState<string | null>(
		null
	);
	const [threadGroups, setThreadGroups] = useState<OnboardingThreadGroup[]>([]);
	const [importing, setImporting] = useState(false);
	const [importedConversationIds, setImportedConversationIds] = useState<
		string[]
	>([]);
	const [profileJob, setProfileJob] = useState<ProfileJobStatus | null>(null);
	const [profileAlreadyBuilt, setProfileAlreadyBuilt] = useState<
		boolean | null
	>(null);
	const [profileStartedAt, setProfileStartedAt] = useState<number | null>(null);
	const [agentSuggestions, setAgentSuggestions] = useState<
		OnboardingAgentSuggestion[]
	>([]);
	const [selectedAgentSuggestions, setSelectedAgentSuggestions] = useState<
		Set<string>
	>(new Set());
	const [agentSuggestionsSubmitting, setAgentSuggestionsSubmitting] =
		useState(false);
	const [agentSuggestionsError, setAgentSuggestionsError] = useState<
		string | null
	>(null);
	const [autoImport, setAutoImport] = useAutoImportThreads();
	const [activationSourceError, setActivationSourceError] = useState<
		string | null
	>(null);
	const [activationError, setActivationError] = useState<string | null>(null);
	const [activationRecommendations, setActivationRecommendations] = useState<
		ActivationRecommendation[]
	>([]);
	const [activationRewardCount, setActivationRewardCount] = useState(0);
	const [activationBusySlug, setActivationBusySlug] = useState<string | null>(
		null
	);
	const [activationCheckoutPending, setActivationCheckoutPending] =
		useState(false);
	const [activationCheckoutOpened, setActivationCheckoutOpened] =
		useState(false);
	const [activationTaskPending, setActivationTaskPending] = useState(false);
	// Which feature the one-feature-per-step wizard is currently showing.
	const [featureIndex, setFeatureIndex] = useState(0);
	const paidPlan = Boolean(entitlement?.managedInference);
	const freeCloud = !paidPlan;
	const selectedOrganization = organizations.find(
		(organization) => organization.id === selectedOrganizationId
	);
	const ownerOrAdmin = ["owner", "admin"].includes(
		(selectedOrganization?.role ?? "").toLowerCase()
	);
	const activationEligibility = useMemo(
		() => deriveActivationEligibility({ gateway: gatewayAccess, ownerOrAdmin }),
		[gatewayAccess, ownerOrAdmin]
	);
	const activationReward = useMemo(
		() => activationRewardProgress(activationRewardCount),
		[activationRewardCount]
	);
	const activationTask = useMemo(
		() => buildActivationTaskDraft(activationRecommendations),
		[activationRecommendations]
	);
	// The activation offer follows the workspace selected during onboarding. A
	// personal workspace must never be shown the five-seat Teams price or sent to
	// the organization checkout route; an organization workspace uses the Teams
	// seat offer. When no workspace has been selected yet, the safe default is the
	// one-person Pro offer.
	const activationUsesOrganizationPlan = Boolean(
		selectedOrganization && !selectedOrganization.isPersonal
	);
	const entitlementStateRef = useRef({
		loading: entitlementLoading,
		paid: paidPlan,
	});
	entitlementStateRef.current = {
		loading: entitlementLoading,
		paid: paidPlan,
	};
	const waitForPaidPlan = useCallback(async () => {
		const deadline = Date.now() + 15_000;
		while (entitlementStateRef.current.loading && Date.now() < deadline) {
			await sleep(100);
		}
		return entitlementStateRef.current.paid;
	}, []);

	const finish = useCallback(
		async (
			target: ApiTarget,
			routeState: unknown = ONBOARDING_CHAT_ROUTE_STATE
		) => {
			if (nodeOnboardingPending) {
				if (!nodeSetupKind) {
					setPhase("node-setup");
					throw new Error(
						"Choose personal or team use before finishing setup."
					);
				}
				const saved = await saveNodeOnboardingState(target, {
					companyContext,
					companyKnowledgeEnabled,
					completed: true,
					setupKind: nodeSetupKind,
				});
				setNodeOnboardingState(saved);
			}
			setPhase("finishing");
			// Memory is enabled before the profile turn and long-term recall is on for
			// the first chat. Existing explicit disables are respected by Core's app
			// seeder; this only opts a fresh onboarding flow into its first build.
			localStorage.setItem("ryu_long_term_memory", "true");

			markDesktopOnboardingComplete();
			track({ event: "onboarding_completed" });
			localStorage.setItem("ryu_default_agent", "ryu");

			await sleep(900);
			setPhase("done");
			await sleep(500);
			navigate("/chat", {
				replace: true,
				state: routeState,
			});
		},
		[
			companyContext,
			companyKnowledgeEnabled,
			navigate,
			nodeOnboardingPending,
			nodeSetupKind,
		]
	);

	const finishNodeOnly = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const active = getActiveNode();
		const node = isLocalNode(active)
			? refreshLocalNode()
			: Promise.resolve(active);
		void node
			.then((resolved) => finish(toTarget(resolved)))
			.catch((error: unknown) => {
				setSubmitting(false);
				sileo.error({
					title: "Node setup could not be completed",
					description:
						error instanceof Error
							? error.message
							: "Try again from this step.",
				});
			});
	}, [finish, getActiveNode, submitting]);

	const handleNodeSetupContinue = useCallback(
		async (
			input: SaveNodeOnboardingStateInput & {
				personalization: UserPersonalization;
			}
		) => {
			if (submitting) {
				return;
			}
			setSubmitting(true);
			setNodeSetupError(null);
			try {
				const target = toTarget(getActiveNode());
				const saved = await saveNodeOnboardingState(target, {
					companyContext: input.companyContext,
					companyKnowledgeEnabled: input.companyKnowledgeEnabled,
					completed: false,
					setupKind: input.setupKind,
				});
				if (input.setupKind === "personal") {
					await setPreference(
						target,
						USER_PERSONALIZATION_PREF_KEY,
						JSON.stringify(input.personalization)
					);
				}
				const [local, cloud] = await Promise.all([
					getLaneAgentSelection(target, "local").catch(() =>
						defaultLocalAgentSelection()
					),
					getLaneAgentSelection(target, "cloud").catch(
						() => EMPTY_AGENT_SELECTION
					),
				]);
				setNodeOnboardingState(saved);
				setNodeSetupKind(input.setupKind);
				setCompanyContext(saved.personalization.companyContext);
				setCompanyKnowledgeEnabled(
					saved.personalization.companyKnowledgeEnabled
				);
				setUserPersonalization(input.personalization);
				setLocalSelection(
					local.agent_id || local.model ? local : defaultLocalAgentSelection()
				);
				setCloudSelection(cloud);
				setPhase("local-default");
			} catch (error) {
				setNodeSetupError(
					error instanceof Error
						? error.message
						: "Ryu couldn't save this node setup. Try again."
				);
			} finally {
				setSubmitting(false);
			}
		},
		[getActiveNode, submitting]
	);

	// Install the user's Add Agents choices before the lane pickers render. This
	// keeps the picker scope honest: onboarding can only offer Ryu plus the agents
	// the user just selected, while the rest of the app remains unconstrained.
	const goToFeatures = useCallback(
		(installIds: string[]) => {
			setAllowedAgentIds(["ryu", ...installIds.filter((id) => id !== "ryu")]);
			setSubmitting(true);
			setPhase("installing");
			void (async () => {
				const active = getActiveNode();
				const node = isLocalNode(active) ? await refreshLocalNode() : active;
				const target = toTarget(node);
				await Promise.allSettled(
					installIds.map((id) => installAgent(target, id))
				);
				triggerAgentsRefresh();
				const [local, cloud] = await Promise.all([
					getLaneAgentSelection(target, "local"),
					getLaneAgentSelection(target, "cloud"),
				]);
				setLocalSelection(
					local.agent_id || local.model ? local : defaultLocalAgentSelection()
				);
				setCloudSelection(cloud);
				setSubmitting(false);
				setPhase(nodeOnboardingPending ? "node-setup" : "local-default");
			})().catch(() => {
				setSubmitting(false);
				setPhase(nodeOnboardingPending ? "node-setup" : "local-default");
			});
		},
		[getActiveNode, nodeOnboardingPending]
	);

	const loadProviderCatalog = useCallback(async (target: ApiTarget) => {
		try {
			const catalog = await fetchPiCatalog(target);
			setPiProviders(catalog.providers);
			setConfiguredProviderIds(
				catalog.providers
					.filter((provider) => provider.configured)
					.map((provider) => provider.id)
			);
		} catch {
			setPiProviders([]);
			setConfiguredProviderIds([]);
		}
	}, []);

	const loadOnboardingConnections = useCallback(async (target: ApiTarget) => {
		const composio = await fetchComposioStatus(target).catch(() => ({
			baseUrl: "",
			configured: false,
		}));
		if (!composio.configured) {
			setToolkits([]);
			setConnections([]);
			setConnectionsCheckFailed(false);
			return;
		}
		const [loadedToolkits, loadedConnections] = await Promise.all([
			fetchComposioToolkits(target).catch(() => []),
			fetchComposioConnections(target).catch(() => null),
		]);
		setToolkits(loadedToolkits);
		setConnections(loadedConnections ?? []);
		setConnectionsCheckFailed(loadedConnections === null);
	}, []);

	const loadOrganizationSetup = useCallback(async () => {
		setSubmitting(true);
		setConnectionsCheckFailed(false);
		setProfileAlreadyBuilt(null);
		const activeNode = getActiveNode();
		const target = toTarget(activeNode);
		const access = await fetchGatewayOnboardingAccess(target).catch(() => null);
		setGatewayAccess(access);
		const allowed = access?.allowed ?? !activeNode.managed;
		setGatewaySetupAllowed(allowed);
		if (!allowed) {
			setSubmitting(false);
			setPhase("cloud-default");
			return;
		}
		const [existingChannels, profileAvailability] = await Promise.all([
			listChannels().catch(() => null),
			fetchProfileAvailability(target).catch(() => null),
		]);
		setChannelConfigs(existingChannels);
		setProfileAlreadyBuilt(profileAvailability?.completed ?? null);
		const paid = await waitForPaidPlan();
		const listed = await listOrgs().catch(() => [] as OrgListEntry[]);
		const active = await getActiveOrgId().catch(() => null);
		const normalized = listed.map((organization) => ({
			id: organization.id,
			isPersonal: organization.isPersonal,
			logo: organization.logo,
			name: organization.name,
			role: organization.role,
			slug: organization.slug,
		}));
		setOrganizations(normalized);
		const selected =
			(active && normalized.some((organization) => organization.id === active)
				? active
				: normalized[0]?.id) ?? null;
		setSelectedOrganizationId(selected);
		if (normalized.length > 1) {
			setSubmitting(false);
			setPhase("organization");
			return;
		}
		if (selected) {
			await setActiveOrg(selected).catch(() => undefined);
		}
		await loadProviderCatalog(target);
		await loadOnboardingConnections(target);
		if (paid) {
			setSubmitting(false);
			setPhase("connections");
		} else {
			setSubmitting(false);
			setPhase("providers");
		}
	}, [
		getActiveNode,
		loadOnboardingConnections,
		loadProviderCatalog,
		waitForPaidPlan,
	]);

	const continueLocalDefault = useCallback(async () => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		await setLaneAgentSelection(target, "local", localSelection).catch(
			() => false
		);
		setSubmitting(false);
		await loadOrganizationSetup();
	}, [getActiveNode, loadOrganizationSetup, localSelection, submitting]);

	const continueOrganization = useCallback(async () => {
		if (submitting || !selectedOrganizationId) {
			return;
		}
		setSubmitting(true);
		const paid = await waitForPaidPlan();
		await setActiveOrg(selectedOrganizationId).catch(() => undefined);
		const target = toTarget(getActiveNode());
		const access = await fetchGatewayOnboardingAccess(target).catch(() => null);
		setGatewayAccess(access);
		setGatewaySetupAllowed(access?.allowed ?? !getActiveNode().managed);
		const profileAvailability = await fetchProfileAvailability(target).catch(
			() => null
		);
		setProfileAlreadyBuilt(profileAvailability?.completed ?? null);
		await loadProviderCatalog(target);
		await loadOnboardingConnections(target);
		if (paid) {
			setPhase("connections");
		} else {
			setPhase("providers");
		}
		setSubmitting(false);
	}, [
		getActiveNode,
		loadOnboardingConnections,
		loadProviderCatalog,
		selectedOrganizationId,
		submitting,
		waitForPaidPlan,
	]);

	const continueProviders = useCallback(() => {
		if (submitting) {
			return;
		}
		setPhase("cloud-default");
	}, [submitting]);

	const configureOnboardingProvider = useCallback(
		(providerId: string, apiKey: string) => {
			if (providerBusyId) {
				return;
			}
			setProviderBusyId(providerId);
			const target = toTarget(getActiveNode());
			configureProvider(target, { apiKey, provider: providerId })
				.then((catalog) => {
					setPiProviders(catalog.providers);
					setConfiguredProviderIds(
						catalog.providers
							.filter((provider) => provider.configured)
							.map((provider) => provider.id)
					);
				})
				.catch(() => undefined)
				.finally(() => setProviderBusyId(null));
		},
		[getActiveNode, providerBusyId]
	);

	const connectOnboardingToolkit = useCallback(
		async (toolkit: ComposioToolkit, accessLevel: ConnectionAccessLevel) => {
			if (connectingToolkit) {
				return;
			}
			setConnectingToolkit(toolkit.slug);
			const target = toTarget(getActiveNode());
			try {
				const result = await initiateComposioConnection(
					target,
					toolkit.slug,
					accessLevel
				);
				if (result.redirectUrl) {
					await openExternal(result.redirectUrl);
				}
				await sleep(1800);
				const connection = await fetchComposioConnectionStatus(
					target,
					result.connectionId
				).catch(() => null);
				if (connection) {
					setConnections((current) => [
						...current.filter((item) => item.id !== connection.id),
						connection,
					]);
				}
			} catch (error) {
				sileo.error({
					title:
						error instanceof Error
							? error.message
							: "Could not start the connection.",
				});
				throw error;
			} finally {
				setConnectingToolkit(null);
			}
		},
		[connectingToolkit, getActiveNode]
	);

	const scanOnboardingThreads = useCallback(async () => {
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		const names = new Map<string, string>();
		for (const agent of [...foundAgents, ...suggestedAgents]) {
			names.set(agent.id, agent.name);
		}
		const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
		const groups: OnboardingThreadGroup[] = [];
		for (const agentId of allowedAgentIds.filter((id) => id !== "ryu")) {
			const result = await listAgentThreads(target, agentId).catch(() => null);
			if (!result?.supported) {
				continue;
			}
			const recent = result.threads.filter(
				(thread) => thread.updatedAt >= cutoff
			);
			if (recent.length > 0) {
				groups.push({
					agentId,
					agentName: names.get(agentId) ?? agentId,
					threads: recent,
				});
			}
		}
		setThreadGroups(groups);
		setSubmitting(false);
		setPhase("imports");
	}, [allowedAgentIds, foundAgents, getActiveNode, suggestedAgents]);

	const continueConnections = useCallback(() => {
		if (submitting) {
			return;
		}
		if (
			entitlementStateRef.current.paid &&
			!cloudSelection.agent_id &&
			!cloudSelection.model
		) {
			setCloudSelection(defaultCloudAgentSelection(true));
		}
		setPhase("cloud-default");
	}, [cloudSelection, paidPlan, submitting]);

	const continueCloudDefault = useCallback(async () => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		const target = toTarget(getActiveNode());
		await setLaneAgentSelection(target, "cloud", cloudSelection).catch(
			() => false
		);
		setSubmitting(false);
		await scanOnboardingThreads();
	}, [cloudSelection, getActiveNode, scanOnboardingThreads, submitting]);

	const eligibleForProfile = useCallback(() => {
		const selectedOrg = organizations.find(
			(organization) => organization.id === selectedOrganizationId
		);
		const role = selectedOrg?.role?.toLowerCase();
		const ownerOrAdmin = role === "owner" || role === "admin";
		const companyKnowledgeReady =
			nodeSetupKind !== "team" || companyKnowledgeEnabled;
		// A paid owner/admin can build a useful first draft even before connecting
		// a source: the agent can use imported sessions and the agent group itself.
		// Connected source ids are still passed when available, and Core performs
		// the authoritative paid-plan/role/consent check before materialising.
		return (
			entitlementStateRef.current.paid && ownerOrAdmin && companyKnowledgeReady
		);
	}, [
		companyKnowledgeEnabled,
		nodeSetupKind,
		organizations,
		selectedOrganizationId,
	]);

	// Advance to the optional microphone step. Voice input is opt-in, so this
	// never blocks finishing — it just gives the OS mic prompt a controlled moment
	// with our own copy instead of firing mid-chat.
	const goToMic = useCallback(() => {
		setPhase("mic");
	}, []);

	const continueAfterNode = useCallback(() => {
		if (desktopOnboardingPending) {
			goToMic();
			return;
		}
		finishNodeOnly();
	}, [desktopOnboardingPending, finishNodeOnly, goToMic]);

	const goToTelegram = useCallback(() => {
		if (nodeOnboardingPending && gatewaySetupAllowed) {
			setPhase("telegram");
			return;
		}
		continueAfterNode();
	}, [continueAfterNode, gatewaySetupAllowed, nodeOnboardingPending]);

	const continueAfterImports = useCallback(() => {
		if (gatewaySetupAllowed && eligibleForProfile()) {
			setPhase("profile");
			return;
		}
		goToTelegram();
	}, [eligibleForProfile, gatewaySetupAllowed, goToTelegram]);

	const continueAfterProfile = useCallback(() => {
		const suggestions = profileJob?.agentSuggestions ?? [];
		if (suggestions.length > 0) {
			setAgentSuggestions(suggestions);
			setSelectedAgentSuggestions(new Set());
			setAgentSuggestionsError(null);
			setPhase("agent-suggestions");
			return;
		}
		goToTelegram();
	}, [goToTelegram, profileJob]);

	const toggleAgentSuggestion = useCallback((id: string) => {
		setSelectedAgentSuggestions((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const createOnboardingAgents = useCallback(async () => {
		if (agentSuggestionsSubmitting || selectedAgentSuggestions.size === 0) {
			return;
		}
		setAgentSuggestionsSubmitting(true);
		setAgentSuggestionsError(null);
		const target = toTarget(getActiveNode());
		const chosen = agentSuggestions.filter((suggestion) =>
			selectedAgentSuggestions.has(suggestion.id)
		);
		const existingAgents = await fetchAgents(target).catch(() => null);
		if (!existingAgents) {
			setAgentSuggestionsError(
				"Ryu couldn't verify your current agents. Try again or skip for now."
			);
			setAgentSuggestionsSubmitting(false);
			return;
		}
		const failed: OnboardingAgentSuggestion[] = [];
		let blockedByLimit = false;
		let createdCount = 0;

		for (const [index, suggestion] of chosen.entries()) {
			if (
				!guardAgentCreation("maxAgents", existingAgents.length + createdCount)
			) {
				blockedByLimit = true;
				failed.push(...chosen.slice(index));
				break;
			}
			try {
				await createAgent(
					target,
					buildSuggestedAgentInput(suggestion, cloudSelection)
				);
				createdCount++;
			} catch {
				failed.push(suggestion);
			}
		}

		if (createdCount > 0) {
			triggerAgentsRefresh();
			sileo.success({
				title: `${createdCount} suggested agent${createdCount === 1 ? "" : "s"} added`,
				description:
					createdCount === 1
						? "It is ready for your next task."
						: "They are ready for your next task.",
			});
		}

		if (failed.length > 0) {
			setAgentSuggestions((current) =>
				current.filter((suggestion) =>
					failed.some((item) => item.id === suggestion.id)
				)
			);
			setSelectedAgentSuggestions(
				new Set(failed.map((suggestion) => suggestion.id))
			);
			setAgentSuggestionsError(
				blockedByLimit
					? "Your plan's agent limit prevented the remaining drafts from being added."
					: createdCount > 0
						? `Added ${createdCount}. Couldn't add ${failed.map((suggestion) => suggestion.name).join(", ")}. Try again or skip.`
						: "Ryu couldn't add those agents yet. Try again or skip for now."
			);
		} else {
			setSelectedAgentSuggestions(new Set());
			goToTelegram();
		}
		setAgentSuggestionsSubmitting(false);
	}, [
		agentSuggestions,
		agentSuggestionsSubmitting,
		cloudSelection,
		guardAgentCreation,
		getActiveNode,
		goToTelegram,
		selectedAgentSuggestions,
	]);

	const importOnboardingThreads = useCallback(async () => {
		if (importing) {
			return;
		}
		setImporting(true);
		const target = toTarget(getActiveNode());
		const imported: string[] = [];
		for (const group of threadGroups) {
			for (const thread of group.threads) {
				const result = await importAgentThread(
					target,
					group.agentId,
					thread.id
				).catch(() => null);
				if (result?.conversationId) {
					imported.push(result.conversationId);
				}
			}
		}
		setImportedConversationIds(imported);
		setImporting(false);
		continueAfterImports();
	}, [continueAfterImports, getActiveNode, importing, threadGroups]);

	const startOnboardingProfile = useCallback(() => {
		if (profileJob && profileJob.state !== "failed") {
			return;
		}
		setProfileJob(null);
		const target = toTarget(getActiveNode());
		void startProfileJob(target, {
			cloudSelection,
			importedConversationIds,
			recentDays: 90,
			shareUserOrg: nodeSetupKind === "team",
			sourceIds: connections
				.filter((connection) => connection.active)
				.map((connection) => connection.id),
		})
			.then((job) => {
				setProfileJob(job);
				setProfileStartedAt(job.startedAtMs);
			})
			.catch(() => goToTelegram());
	}, [
		cloudSelection,
		connections,
		getActiveNode,
		goToTelegram,
		importedConversationIds,
		nodeSetupKind,
		profileJob,
	]);

	const cancelOnboardingProfile = useCallback(() => {
		const job = profileJob;
		if (!job) {
			goToTelegram();
			return;
		}
		void cancelProfileJob(toTarget(getActiveNode()), job.id).finally(() => {
			setProfileJob(null);
			goToTelegram();
		});
	}, [getActiveNode, profileJob]);

	const backgroundOnboardingProfile = useCallback(() => {
		if (!profileJob) {
			return;
		}
		void continueProfileJobInBackground(
			toTarget(getActiveNode()),
			profileJob.id
		).then(setProfileJob);
	}, [getActiveNode, goToTelegram, profileJob]);

	const skipCloudDefault = useCallback(async () => {
		if (submitting) {
			return;
		}
		setCloudSelection(EMPTY_AGENT_SELECTION);
		setSubmitting(true);
		await setLaneAgentSelection(
			toTarget(getActiveNode()),
			"cloud",
			EMPTY_AGENT_SELECTION
		).catch(() => false);
		setSubmitting(false);
		await scanOnboardingThreads();
	}, [getActiveNode, scanOnboardingThreads, submitting]);

	useEffect(() => {
		if (
			phase !== "profile" ||
			!profileJob ||
			(profileJob.state !== "queued" && profileJob.state !== "building")
		) {
			return;
		}
		const interval = window.setInterval(() => {
			void getProfileJobStatus(toTarget(getActiveNode()), profileJob.id)
				.then(setProfileJob)
				.catch(() => undefined);
		}, 1000);
		return () => window.clearInterval(interval);
	}, [getActiveNode, phase, profileJob]);

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

	/**
	 * Land on the interactive agents step with whatever detection could tell us.
	 *
	 * Unconditional, on purpose. Both call sites used to gate this on
	 * `found.length > 0 || suggested.length > 0`, which made a static, curated
	 * offer depend on a live network call: one 401 (or one slow catalog) and the
	 * "Add your agents" step vanished from the wizard with no error, no toast and
	 * no log — the step looked deleted. A failed lookup now degrades the CONTENT
	 * of the step (curated rows plus a retry), never its existence.
	 */
	const showAgentsStep = useCallback((node: Node, result: OnboardingAgents) => {
		setAgentsNode(node);
		setAgentsUnavailable(!result.ok);
		setFoundAgents(result.found);
		setSuggestedAgents(result.suggested);
		// Pre-select the ones already found on the user's system.
		setSelected(new Set(result.found.map((a) => a.id)));
		setPhase("agents");
	}, []);

	// Re-run detection from the step itself, after the inline "couldn't check
	// what's already installed" notice. Re-resolves the local node first, so a
	// token Core minted since the first attempt is picked up.
	const handleRetryAgents = useCallback(() => {
		if (!agentsNode || agentsRetrying) {
			return;
		}
		setAgentsRetrying(true);
		(async () => {
			const node = isLocalNode(agentsNode)
				? await refreshLocalNode()
				: agentsNode;
			const result = await loadOnboardingAgents(toTarget(node));
			if (cancelledRef.current) {
				return;
			}
			setAgentsRetrying(false);
			setAgentsNode(node);
			setAgentsUnavailable(!result.ok);
			setFoundAgents(result.found);
			setSuggestedAgents(result.suggested);
			// Keep whatever the user already ticked; add the newly-detected ones.
			setSelected((prev) => {
				const next = new Set(prev);
				for (const a of result.found) {
					next.add(a.id);
				}
				return next;
			});
		})().catch(() => {
			if (!cancelledRef.current) {
				setAgentsRetrying(false);
			}
		});
	}, [agentsNode, agentsRetrying]);

	// The local (bring-your-own-keys) path: wait for the local stack, then detect
	// installable CLI agents and move to the interactive 'agents' step. It takes
	// no node argument any more: the caller's node object predates Core's first
	// boot (and therefore its minted token), so the node is resolved HERE, after
	// the boot, and again per leg.
	const beginLocalSetup = useCallback(async () => {
		setPhase("installing");
		const node = await refreshLocalNode();
		if (cancelledRef.current) {
			return;
		}
		// # 0.1.0: Island disabled — uncomment when re-enabling Island onboarding
		// Best-effort: get the Island companion installed + launched during
		// onboarding so it's ready by first chat. Fire-and-forget (no `await`) and
		// non-fatal — it must never block or fail onboarding, and dev is a no-op.
		// installAndLaunchIsland().catch(() => undefined);
		await waitForLocalStack(node, () => cancelledRef.current, localReport);
		if (cancelledRef.current) {
			return;
		}

		localReport.status("Looking for agents on your system…", STAGE_AGENTS);
		// Re-resolve once more: `waitForLocalStack` can run for 45s, and on a first
		// run the token may only have appeared inside that window.
		const detectNode = await refreshLocalNode();
		const result = await loadOnboardingAgents(toTarget(detectNode));
		localReport.status(null);
		if (cancelledRef.current) {
			return;
		}
		showAgentsStep(detectNode, result);
	}, [localReport, showAgentsStep]);

	// Present the update step only in the native desktop shell, then the local /
	// cloud / existing-node fork immediately in browser surfaces. This used to
	// wait for `coreStatus === "running"`, which made a local Core a hard
	// prerequisite for even *seeing* the choice — so the one screen offering "you
	// don't need a local Core" was unreachable without one. Nothing on this step
	// talks to Core; each path brings up (or connects to) its own backend from the
	// user's pick. Only advances out of 'starting' so a later phase is never
	// yanked back to the fork.
	useEffect(() => {
		setPhase((p) => {
			if (p !== "starting") {
				return p;
			}
			return isTauriReady() ? "updates" : "choose";
		});
	}, []);

	// Local pick. Three things it owns:
	//
	// 1. Bring Core up. The app no longer requires (or auto-installs) a local Core
	//    to open, so this pick is where one is installed and started —
	//    `startLocalCore` is a no-op when it is already running, which is the
	//    common case in dev and for a returning user.
	// 2. Resolve the LOCAL node explicitly instead of `getActiveNode()`, whose
	//    default may already be a cloud node — the button labelled "local" was
	//    otherwise able to run local setup against the CLOUD node.
	// 3. Confirm it answers before committing. `waitForLocalStack` swallows every
	//    error and proceeds anyway after 45s, so an unreachable node used to end
	//    with the user inside a fully broken app and onboarding marked complete.
	//    Instead fall BACK to `choose`, where the other two paths are still offered.
	//
	// The pick leaves the fork immediately for the `installing` phase. Everything
	// after the press — the 160 MB download, Core's boot, the local-stack wait — is
	// one continuous wait with one progress bar and one status line, rather than a
	// second progress surface bolted onto the choice card. The card only has to
	// render the FAILURE, which is the one outcome that returns here.
	const handleChooseLocal = useCallback(() => {
		if (localChecking) {
			return;
		}
		setMode("local");
		setLocalChecking(true);
		// Seed the bar before the first await so the phase's flat placeholder never
		// flashes ahead of the real download and then jumps backwards.
		liveStatusRef.current = "Getting Ryu ready…";
		doneStatusRef.current = [];
		setLocalPercent(STAGE_PREPARING);
		setPhase("installing");
		(async () => {
			// `startLocalCore` resolves only once `/api/health` on the local Core
			// answered, so this IS the reachability proof — no second probe, and no
			// dependency on `nodes.json` existing yet (on a fresh install the file is
			// written a few lines below, by `setDefault`).
			const started = await startLocalCore(
				() => cancelledRef.current,
				localReport
			);
			if (cancelledRef.current) {
				return;
			}
			setLocalChecking(false);
			if (!started.ok) {
				setLocalError(started.error ?? null);
				setLocalUnreachable(true);
				setPhase("choose");
				return;
			}
			setLocalError(null);
			setLocalUnreachable(false);
			// Resolve the local node only NOW. Core has just booted, and on a first
			// run that boot is what minted `node-auth.token`; the store was hydrated
			// before it existed, so anything captured earlier is tokenless and every
			// Core call made with it 401s.
			const node = await refreshLocalNode();
			// Point the app at the node we just verified, so the rest of onboarding
			// and the app itself talk to it rather than a stale cloud default.
			await activateOnboardingNode(node);
			await beginLocalSetup().catch(() => undefined);
		})().catch(() => {
			if (!cancelledRef.current) {
				setLocalChecking(false);
				setLocalUnreachable(true);
				setPhase("choose");
			}
		});
	}, [activateOnboardingNode, beginLocalSetup, localChecking, localReport]);

	// The only in-product path to a local node: the desktop app hosts it.
	const handleDownloadDesktop = useCallback(() => {
		openExternal(`${WEB_URL}/download`).catch(() => undefined);
	}, []);

	// Open the connect form. Nothing is committed here — the address is probed on
	// submit, and only a node that answers is written to nodes.json.
	const handleChooseRemote = useCallback(() => {
		setRemoteError(null);
		setMode("remote");
		setPhase("connect");
	}, []);

	const handleBackFromConnect = useCallback(() => {
		if (remoteChecking) {
			return;
		}
		setRemoteError(null);
		setMode(null);
		setPhase("choose");
	}, [remoteChecking]);

	// Adopt a node the user already runs (their team's server, another machine on
	// the LAN or mesh). Probe first, persist second: a node that never answered
	// would otherwise sit in the picker forever. Once adopted we run the SAME
	// agent detection the local path does — a company node is a full Core with a
	// real catalog, unlike a managed node, which runs its own inference — but skip
	// `waitForLocalStack`, which polls a local install this device does not have.
	const handleConnectRemote = useCallback(
		(rawUrl: string, token: string) => {
			if (remoteChecking) {
				return;
			}
			const url = normalizeNodeUrl(rawUrl);
			if (url === "") {
				setRemoteError("Enter the node's address.");
				return;
			}
			setRemoteChecking(true);
			setRemoteError(null);
			(async () => {
				const online = await probeNodeUrl(url, token);
				if (cancelledRef.current) {
					return;
				}
				if (!online) {
					setRemoteChecking(false);
					setRemoteError(
						"Couldn't reach a Ryu node there. Check the address, the port, and that the node is running — and the token if it needs one."
					);
					return;
				}

				const state = useNodeStore.getState();
				const existing = state.nodes.find(
					(n) => n.url.replace(/\/+$/, "") === url
				);
				let name = existing?.name;
				const normalizedToken = token.trim() || null;
				if (
					existing &&
					!existing.managed &&
					normalizedToken !== existing.token
				) {
					try {
						await updateNodeToken(existing.name, normalizedToken);
					} catch (err) {
						if (cancelledRef.current) {
							return;
						}
						setRemoteChecking(false);
						setRemoteError(
							err instanceof Error
								? err.message
								: "Couldn't update this node's token. Try again."
						);
						return;
					}
				}
				if (!name) {
					name = nodeNameForUrl(
						url,
						state.nodes.map((n) => n.name)
					);
					try {
						await state.addNode(name, url, token === "" ? undefined : token);
					} catch (err) {
						if (cancelledRef.current) {
							return;
						}
						setRemoteChecking(false);
						setRemoteError(
							err instanceof Error
								? err.message
								: "Couldn't save this node. Try again."
						);
						return;
					}
				}
				if (cancelledRef.current) {
					return;
				}
				// Route the rest of onboarding — and the app — at the node we just
				// verified. A cloud-shaped node isn't in nodes.json, so the shared
				// activation helper falls back to an in-memory default when needed.
				const activeNode = await activateOnboardingNode({
					name,
					token: normalizedToken,
					url,
				});
				setRemoteChecking(false);

				const node =
					useNodeStore
						.getState()
						.nodes.find((n) => n.name === activeNode.name) ?? activeNode;
				const result = await loadOnboardingAgents(toTarget(node));
				if (cancelledRef.current) {
					return;
				}
				showAgentsStep(node, result);
			})().catch(() => {
				if (!cancelledRef.current) {
					setRemoteChecking(false);
					setRemoteError("Couldn't connect to that node. Try again.");
				}
			});
		},
		[activateOnboardingNode, remoteChecking, showAgentsStep, updateNodeToken]
	);

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
		setMode("managed");
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
			await activateOnboardingNode(adopted);
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
		// Fall back to the local path so onboarding still completes — which now
		// means actually bringing a local Core up, since the app no longer starts
		// one at boot. Same explicit local-node resolution as the local pick;
		// `getActiveNode()` here could be the cloud node we just failed to adopt.
		setMode("local");
		// Same `localChecking` bookkeeping the direct local pick does. Without it
		// this path showed no download progress at all, and — because `coreFailed`
		// is `coreStatus === "stopped" && mode === "local" && !localChecking` —
		// flipping `mode` to "local" after App.tsx's startup grace had elapsed
		// replaced the running 160 MB download with the "Couldn't start Ryu"
		// restart screen.
		setLocalChecking(true);
		liveStatusRef.current = "Getting Ryu ready…";
		setLocalPercent(STAGE_PREPARING);
		setPhase("installing");
		startLocalCore(() => cancelledRef.current, localReport)
			.then((started) => {
				setLocalChecking(false);
				if (!started.ok || cancelledRef.current) {
					setLocalError(started.error ?? null);
					setLocalUnreachable(true);
					setPhase("choose");
					return undefined;
				}
				// Re-read and activate the local node after the boot that mints its
				// token; the managed node may still be the previous default.
				return refreshLocalNode()
					.then((node) => activateOnboardingNode(node))
					.then(() => beginLocalSetup());
			})
			.catch(() => undefined);
	}, [
		entitlement,
		managedBusy,
		hydrateCloudNodes,
		activateOnboardingNode,
		goToFeatures,
		beginLocalSetup,
		localReport,
	]);

	// Cycle the header line while a long auto-advancing phase is on screen, so the
	// view never looks frozen — but alternate the flavour copy with the REAL state
	// of the work: what is downloading right now, or the last thing that finished.
	// A pure flavour loop is indistinguishable from a hang, and it was hiding two
	// entire install legs (gateway, local engine) behind "Teaching Ryu to think".
	useEffect(() => {
		const flavour = ROTATING_SUBTITLES[phase];
		if (!flavour) {
			setLoopLine(null);
			return;
		}
		let tick = 0;
		let flavourIndex = 0;
		const advance = () => {
			const real =
				liveStatusRef.current ?? doneStatusRef.current.at(-1) ?? null;
			// Every other tick is the real line, when there is one. The flavour index
			// advances only on flavour turns, so nothing is skipped — and on a phase
			// with no real state to report (the cloud paths) every tick is flavour and
			// the loop behaves exactly as it did before.
			if (tick % 2 === 1 && real) {
				setLoopLine(real);
			} else {
				setLoopLine(flavour[flavourIndex % flavour.length] ?? null);
				flavourIndex += 1;
			}
			tick += 1;
		};
		advance();
		const id = setInterval(advance, ROTATE_INTERVAL_MS);
		return () => clearInterval(id);
	}, [phase]);

	// When Ryu never comes up (App.tsx flips it to "stopped" after its startup
	// timeout) a local-path user would otherwise sit on a shimmering progress bar
	// with no way out, so we render a dedicated error state with a restart button.
	// Scoped to the LOCAL path: a user who picked the cloud or their own node has
	// no local Core by design, and "stopped" is the correct, expected state for
	// them — blocking them on it is what made the desktop unusable without an
	// install in the first place.
	// Not while the local pick is still working: `startLocalCore` may be several
	// minutes into downloading the binary, which is longer than App.tsx's startup
	// grace — reporting that as "Couldn't start Ryu" would replace a working
	// install with an error screen. A genuine failure there ends on `choose` with
	// the unreachable card instead.
	const coreFailed =
		coreStatus === "stopped" && mode === "local" && !localChecking;
	// On the auto-advancing phases the rotating copy IS the headline; everywhere
	// else the static title/subtitle pair carries the step. Every non-rotating
	// phase has a PHASE_TITLES entry, so the fallthrough is always defined.
	const subtitle = loopLine ? undefined : PHASE_SUBTITLES[phase];
	const title = loopLine ?? PHASE_TITLES[phase]!;

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

	// The mic answer (either way) hands off to the look-and-feel step, so the user
	// lands in an app that already looks like theirs. Clearing `submitting` matters:
	// the mic step sets it while the OS prompt is up, and leaving it pinned would
	// render the theme step's Continue disabled.
	const goToTheme = useCallback(() => {
		setSubmitting(false);
		setPhase("theme");
	}, []);

	// Leave the mic step. Skip goes straight on; Allow requests mic access first
	// (non-blocking: a denial still completes onboarding).
	const handleSkipMic = useCallback(() => {
		if (submitting) {
			return;
		}
		goToTheme();
	}, [submitting, goToTheme]);

	const handleAllowMic = useCallback(async () => {
		if (submitting) {
			return;
		}
		setSubmitting(true);
		try {
			// `getUserMedia` only settles when the OS prompt is answered, so an
			// ignored (or focus-lost) TCC dialog leaves it pending forever. With both
			// mic buttons disabled while `submitting`, that used to be a dead end;
			// race it so onboarding always moves on. The grant still lands if the
			// user answers later — we just stop waiting for them.
			await Promise.race([ensureMicPermission(), sleep(MIC_PROMPT_MAX_MS)]);
		} catch {
			// Permission prompt denied or unavailable — still continue onboarding.
		}
		if (cancelledRef.current) {
			return;
		}
		goToTheme();
	}, [submitting, goToTheme]);

	// The theme step already persisted every pick as it was made, so Continue
	// hands off to the node-wide safety posture step.
	const goToSafety = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(false);
		setPhase(nodeOnboardingPending ? "safety" : "preferences");
	}, [nodeOnboardingPending, submitting]);

	// The safety step applies Gateway + Core controls explicitly, then hands off
	// to the general desktop preferences step.
	const goToPreferences = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(false);
		setPhase("preferences");
	}, [submitting]);

	// The preferences step persists each toggle as it's flipped, so Continue just
	// hands off to the privacy step.
	const goToPrivacy = useCallback(() => {
		if (submitting) {
			return;
		}
		setSubmitting(false);
		setPhase("privacy");
	}, [submitting]);

	// The privacy step already persisted every consent as it was made. Show the
	// final welcome animation before installing agents and handing off to chat.
	const handleFinishPrivacy = useCallback(() => {
		if (submitting) {
			return;
		}
		setPhase("welcome");
	}, [submitting]);

	const finishOnboarding = useCallback(
		(routeState: unknown = ONBOARDING_CHAT_ROUTE_STATE) => {
			if (submitting) {
				return;
			}
			setSubmitting(true);
			(async () => {
				// Re-resolve the local node one last time: this is the call that actually
				// ADDS the agents the user picked, and a tokenless target would 401 every
				// one of them into Promise.allSettled's silent rejected bucket.
				const active = getActiveNode();
				const node = isLocalNode(active) ? await refreshLocalNode() : active;
				await finish(toTarget(node), routeState);
			})().catch((error: unknown) => {
				setSubmitting(false);
				sileo.error({
					title: "Onboarding could not be completed",
					description:
						error instanceof Error
							? error.message
							: "Try again from this step.",
				});
			});
		},
		[submitting, getActiveNode, finish]
	);

	const enterActivationApps = useCallback(() => {
		setActivationError(null);
		setActivationRecommendations(
			buildActivationRecommendations({ connections, toolkits })
		);
		setPhase("activation-apps");
		void fetchActivationRewardSummary()
			.then((summary) => setActivationRewardCount(summary.completed))
			.catch(() => undefined);
	}, [connections, toolkits]);

	const handleActivationSource = useCallback(
		(source: Parameters<typeof saveOnboardingSource>[0]) => {
			if (submitting) {
				return;
			}
			setSubmitting(true);
			setActivationSourceError(null);
			void saveOnboardingSource(source)
				.then(enterActivationApps)
				.catch(() =>
					setActivationSourceError(
						"We couldn't save that answer. Try again or check your connection."
					)
				)
				.finally(() => setSubmitting(false));
		},
		[enterActivationApps, submitting]
	);

	const handleActivationConnect = useCallback(
		async (
			recommendation: ActivationRecommendation,
			accessLevel: ConnectionAccessLevel
		) => {
			const appSlug = recommendation.appSlug;
			if (!appSlug || activationBusySlug) {
				return;
			}
			setActivationBusySlug(appSlug);
			setActivationError(null);
			const target = toTarget(getActiveNode());
			try {
				const result = await initiateComposioConnection(
					target,
					appSlug,
					accessLevel
				);
				if (result.redirectUrl) {
					await openExternal(result.redirectUrl);
				}
				await sleep(1800);
				const connection = await fetchComposioConnectionStatus(
					target,
					result.connectionId
				);
				if (!connection.active) {
					throw new Error("The app connection is not active yet.");
				}
				const nextConnections = [
					...connections.filter((item) => item.id !== connection.id),
					connection,
				];
				setConnections(nextConnections);
				setActivationRecommendations(
					buildActivationRecommendations({
						connections: nextConnections,
						toolkits,
					})
				);
				if (activationEligibility.rewardAllowed) {
					try {
						const reward = await claimActivationReward({
							appSlug,
							connectionId: connection.id,
						});
						setActivationRewardCount(reward.completed);
					} catch {
						setActivationError(
							"Connected. Your bonus credit is pending and can be retried from this step."
						);
					}
				}
			} catch (error) {
				setActivationError(
					error instanceof Error
						? error.message
						: "The app connection could not be completed."
				);
				throw error;
			} finally {
				setActivationBusySlug(null);
			}
		},
		[
			activationBusySlug,
			activationEligibility.rewardAllowed,
			connections,
			getActiveNode,
			toolkits,
		]
	);

	const continueActivationApps = useCallback(() => {
		if (activationBusySlug) {
			return;
		}
		setActivationError(null);
		setPhase("activation-value");
	}, [activationBusySlug]);

	const continueActivationValue = useCallback(() => {
		setActivationError(null);
		setPhase("activation-offer");
	}, []);

	const confirmActivationSubscription = useCallback(async () => {
		if (activationCheckoutPending) {
			return;
		}
		setActivationCheckoutPending(true);
		setActivationError(null);
		const deadline = Date.now() + 30_000;
		try {
			while (Date.now() < deadline) {
				const status = await fetchEntitlementStatus().catch(() => null);
				if (status?.entitlement?.managedInference) {
					await refreshCredits();
					setActivationCheckoutPending(false);
					setActivationCheckoutOpened(false);
					setPhase("activation-task");
					return;
				}
				await sleep(1500);
			}
			setActivationError(
				"We haven't received the subscription confirmation yet. Return after the payment completes and try again."
			);
		} finally {
			setActivationCheckoutPending(false);
		}
	}, [activationCheckoutPending, refreshCredits]);

	const startActivationCheckout = useCallback(async () => {
		if (activationCheckoutPending) {
			return;
		}
		setActivationCheckoutPending(true);
		setActivationError(null);
		try {
			const checkout = await stepUp.guard("billing", async () => {
				if (activationUsesOrganizationPlan) {
					return (await checkoutTeamsOnboarding(selectedOrganizationId)).url;
				}
				return await createCheckout("pro-monthly");
			});
			if (checkout === null) {
				return;
			}
			await openExternal(checkout);
			setActivationCheckoutOpened(true);
			setActivationError(
				"Checkout is open in your browser. Finish there, return to Ryu, then confirm."
			);
		} catch (error) {
			setActivationError(
				error instanceof CheckoutError
					? error.message
					: "We couldn't start checkout. Try again."
			);
		} finally {
			setActivationCheckoutPending(false);
		}
	}, [
		activationCheckoutPending,
		activationUsesOrganizationPlan,
		selectedOrganizationId,
		stepUp,
	]);

	const continueActivationOffer = useCallback(() => {
		if (paidPlan) {
			setPhase("activation-task");
		}
	}, [paidPlan]);

	const startActivationTask = useCallback(async () => {
		if (activationTaskPending) {
			return;
		}
		if (!activationEligibility.taskAllowed) {
			setActivationError(
				"This workspace cannot create an onboarding task. Ask the node owner to continue."
			);
			return;
		}
		setActivationTaskPending(true);
		setActivationError(null);
		try {
			const status = await fetchEntitlementStatus();
			if (!status.entitlement?.managedInference) {
				setPhase("activation-offer");
				setActivationError(
					"Confirm the subscription before starting this task."
				);
				return;
			}
			const active = getActiveNode();
			const node = isLocalNode(active) ? await refreshLocalNode() : active;
			const target = toTarget(node);
			const stored = localStorage.getItem("ryu_onboarding_activation_task");
			if (!stored) {
				const quest = await createQuest(target, {
					completion_condition:
						"The agent returns the requested task brief and the user confirms the result is useful.",
					detail: activationTask.prompt,
					title: activationTask.title,
				});
				localStorage.setItem(
					"ryu_onboarding_activation_task",
					JSON.stringify({ id: quest.id, title: quest.title })
				);
			}
			await finish(
				target,
				buildOnboardingTaskRouteState({
					prompt: activationTask.prompt,
					title: activationTask.title,
				})
			);
		} catch (error) {
			setActivationError(
				error instanceof Error
					? error.message
					: "The first task could not be created. Try again."
			);
		} finally {
			setActivationTaskPending(false);
		}
	}, [
		activationEligibility.taskAllowed,
		activationTask,
		activationTaskPending,
		finish,
		getActiveNode,
	]);

	const continueAfterWelcome = useCallback(() => {
		if (activationEligibility.recommendationsAllowed) {
			setPhase("activation-source");
			return;
		}
		finishOnboarding();
	}, [activationEligibility.recommendationsAllowed, finishOnboarding]);

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

	const setupTarget = toTarget(getActiveNode());
	const setupProviderIds = paidPlan
		? Array.from(new Set([...configuredProviderIds, "managed-openrouter"]))
		: configuredProviderIds;
	const setupProps = {
		allowedAgentIds,
		agentSuggestions,
		agentSuggestionsError,
		agentSuggestionsSelected: selectedAgentSuggestions,
		agentSuggestionsSubmitting,
		allowedProviderIds:
			phase === "local-default" ? ["local"] : setupProviderIds,
		autoImport,
		alreadyBuilt: profileAlreadyBuilt,
		cloudSelection,
		connections,
		connectionQuery,
		connectionsCheckFailed,
		connectingToolkit,
		defaultProviderIds: configuredProviderIds,
		freeCloud,
		importing,
		kind: phase as OnboardingSetupKind,
		localSelection,
		organizations,
		piProviders,
		nodeSetupKind,
		profileJob,
		profileStartedAt,
		providerBusyId,
		selectedOrganizationId,
		target: setupTarget,
		threadGroups,
		toolkits,
		onBackgroundProfile: backgroundOnboardingProfile,
		onCancelProfile: cancelOnboardingProfile,
		onCreateAgentSuggestions: () => {
			void createOnboardingAgents();
		},
		onChooseOrganization: setSelectedOrganizationId,
		onConfigureProvider: configureOnboardingProvider,
		onConnectToolkit: connectOnboardingToolkit,
		onContinue:
			phase === "local-default"
				? continueLocalDefault
				: phase === "organization"
					? continueOrganization
					: phase === "providers"
						? continueProviders
						: phase === "connections"
							? continueConnections
							: phase === "cloud-default"
								? continueCloudDefault
								: phase === "imports"
									? importOnboardingThreads
									: startOnboardingProfile,
		onImportThreads: importOnboardingThreads,
		onContinueBackgroundProfile: goToTelegram,
		onLocalSelectionChange: setLocalSelection,
		onCloudSelectionChange: setCloudSelection,
		onSearchConnections: setConnectionQuery,
		onSkip:
			phase === "cloud-default"
				? skipCloudDefault
				: phase === "imports"
					? continueAfterImports
					: phase === "profile"
						? continueAfterProfile
						: goToTelegram,
		onToggleAutoImport: setAutoImport,
		onToggleAgentSuggestion: toggleAgentSuggestion,
	};

	if (phase === "updates") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<UpdateStep onContinue={() => setPhase("choose")} />
			</div>
		);
	}

	if (phase === "node-setup") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<NodePersonalizationStep
					busy={submitting}
					canConfigure={nodeOnboardingState?.canConfigure ?? true}
					companyContext={companyContext}
					error={nodeSetupError}
					initialPersonalization={userPersonalization}
					initialSetupKind={nodeSetupKind}
					onContinue={handleNodeSetupContinue}
				/>
			</div>
		);
	}

	if (
		phase === "local-default" ||
		phase === "organization" ||
		phase === "providers" ||
		phase === "connections" ||
		phase === "cloud-default" ||
		phase === "imports" ||
		phase === "profile" ||
		phase === "agent-suggestions"
	) {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<OnboardingSetupStep {...setupProps} />
			</div>
		);
	}

	if (phase === "telegram") {
		const openTelegramLogin = () => {
			void openExternal(`${WEB_URL}/telegram/connect`).catch(() => undefined);
		};
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<TelegramOnboardingStep
					existingChannelCount={channelConfigs?.length ?? null}
					onContinue={continueAfterNode}
					onSkip={continueAfterNode}
					onUseTelegramLogin={openTelegramLogin}
				/>
			</div>
		);
	}

	// The theme/safety/preferences/privacy steps are desktop-only (they drive the
	// desktop's own theme setters, appearance toggles, autostart registration,
	// and Core privacy prefs), so they render here rather than through the shared
	// block, whose `OnboardingStep` union has no member for them.
	if (phase === "theme") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<ColorStep busy={submitting} onContinue={goToSafety} />
			</div>
		);
	}

	if (phase === "safety") {
		const activeNode = getActiveNode();
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<SafetyPostureStep
					onContinue={goToPreferences}
					target={toTarget(activeNode)}
				/>
			</div>
		);
	}

	if (phase === "preferences") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<PreferencesStep busy={submitting} onContinue={goToPrivacy} />
			</div>
		);
	}

	if (phase === "privacy") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<PrivacyStep busy={submitting} onContinue={handleFinishPrivacy} />
			</div>
		);
	}

	if (phase === "welcome") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<WelcomeStep onContinue={continueAfterWelcome} />
			</div>
		);
	}

	if (phase === "activation-source") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<AcquisitionSourceStep
					busy={submitting}
					error={activationSourceError}
					onContinue={handleActivationSource}
				/>
			</div>
		);
	}

	if (phase === "activation-apps") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<ActivationRecommendationsStep
					busySlug={activationBusySlug}
					error={activationError}
					onConnect={handleActivationConnect}
					onContinue={continueActivationApps}
					recommendations={activationRecommendations}
					rewardProgress={activationReward}
				/>
			</div>
		);
	}

	if (phase === "activation-value") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<ActivationValueStep
					onContinue={continueActivationValue}
					organizationPlan={activationUsesOrganizationPlan}
				/>
			</div>
		);
	}

	if (phase === "activation-offer") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<ActivationOfferStep
					checkoutOpened={activationCheckoutOpened}
					dialog={stepUp.dialog}
					error={activationError}
					onConfirmCheckout={confirmActivationSubscription}
					onContinue={continueActivationOffer}
					onSkip={finishOnboarding}
					onStartCheckout={() => {
						void startActivationCheckout();
					}}
					organizationPlan={activationUsesOrganizationPlan}
					pending={activationCheckoutPending}
					subscribed={paidPlan}
				/>
			</div>
		);
	}

	if (phase === "activation-task") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<ActivationTaskStep
					draft={activationTask}
					error={activationError}
					onStart={() => {
						void startActivationTask();
					}}
					pending={activationTaskPending}
				/>
			</div>
		);
	}

	return (
		<div className="size-full" data-tauri-drag-region="true">
			<OnboardingView
				agents={foundAgents.map(withAgentLogo)}
				agentsRetrying={agentsRetrying}
				agentsUnavailable={agentsUnavailable}
				currentFeature={TOGGLEABLE_FEATURES[featureIndex]}
				featureStepIndex={featureIndex + 1}
				featureStepTotal={TOGGLEABLE_FEATURES.length}
				isDesktop={isDesktop}
				localChecking={localChecking}
				localError={localError}
				localUnreachable={localUnreachable}
				managedBusy={managedBusy}
				managedEntitled={Boolean(entitlement?.managedInference)}
				managedLoading={entitlementLoading}
				micSubmitting={submitting}
				onBackFromConnect={handleBackFromConnect}
				onChooseLocal={handleChooseLocal}
				onChooseManaged={handleChooseManaged}
				onChooseRemote={handleChooseRemote}
				onConnectRemote={handleConnectRemote}
				onContinueAgents={handleContinue}
				onContinueMic={handleAllowMic}
				onDownloadDesktop={handleDownloadDesktop}
				onEnableFeature={() => applyFeatureChoice(true)}
				onRetryAgents={handleRetryAgents}
				onSkipAgents={() => goToFeatures([])}
				onSkipFeature={() => applyFeatureChoice(false)}
				onSkipMic={handleSkipMic}
				onToggleAgent={toggle}
				progress={localPercent ?? PHASE_PROGRESS[phase]}
				remoteChecking={remoteChecking}
				remoteError={remoteError}
				selected={selected}
				step={phase}
				subtitle={subtitle}
				suggestedAgents={suggestedAgents.map(withAgentLogo)}
				title={title}
			/>
		</div>
	);
}
