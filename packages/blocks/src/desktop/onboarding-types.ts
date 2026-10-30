import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { ReactNode } from "react";

/** A detectable CLI agent as the picker needs it. Mirrors the container's
 *  `AgentCatalogEntry` (only the fields the view renders). */
export interface OnboardingAgentOption {
	description: string | null;
	/** Whether the agent's CLI binary was found on PATH. */
	detected: boolean | null;
	id: string;
	/** Install command shown when the agent is not found. */
	installHint: string | null;
	/** Brand logo node, resolved by the container (the shared block can't reach
	 *  the desktop's `AgentCatalogLogo`). Rendered next to the name when present. */
	logo?: ReactNode;
	name: string;
}

/** An optional external skill collection offered during node onboarding. */
export interface OnboardingSkillPackOption {
	description: string;
	id: string;
	name: string;
}

/** A toggleable feature offered on the `features` step. The container supplies
 *  the catalog (name + one-line purpose); the view only renders it. */
export interface OnboardingFeatureOption {
	description: string;
	/** Stable key matching the sidebar section the feature maps to. */
	key: string;
	name: string;
}

/** Which step of the wizard to render. `installing`/`starting`/`finishing`/
 *  `done` all share the same shell with an indeterminate (or full) progress
 *  bar; `agents`, `skills`, `features`, and `mic` are the interactive steps. */
export type OnboardingStep =
	| "starting"
	| "choose"
	| "connect"
	| "installing"
	| "agents"
	| "skills"
	| "features"
	| "mic"
	| "finishing"
	| "done";

/** Login-style PageHeader copy for each step. The container maps its phase
 *  onto `title` + optional `subtitle` (rotating loading lines use subtitle). */
export interface OnboardingViewProps {
	/** Custom default-agent avatar selected earlier in this first-run flow. */
	agentAvatarGlyph?: GlyphValue;
	/** Agents found on the user's system (detected on PATH), shown under the
	 *  "Found on your system" header on the `agents` step and pre-selected. */
	agents?: OnboardingAgentOption[];
	/** A retry of the agent lookup is in flight (the notice shows a busy Retry). */
	agentsRetrying?: boolean;
	/** The agent lookup FAILED (node unreachable, unauthorized, timed out), so
	 *  the rows on screen are the curated fallback and nothing could be detected.
	 *  Shows an inline notice with a Retry instead of hiding the step — a failed
	 *  lookup degrades this step's content, it never removes the step. */
	agentsUnavailable?: boolean;
	/** The single feature shown on the current `features` step (one per step). */
	currentFeature?: OnboardingFeatureOption;
	/** 1-based position of the current feature step (e.g. 2 of 4). */
	featureStepIndex?: number;
	/** Total number of feature steps, for the "X of Y" progress hint. */
	featureStepTotal?: number;
	/** True when rendered inside the desktop app. The desktop can *install* a
	 *  local Core itself, so an unreachable local path there is a retry, not the
	 *  webapp's "download the desktop app" dead end. */
	isDesktop?: boolean;
	/** A local reachability probe is in flight (the card shows a checking state). */
	localChecking?: boolean;
	/** Why the local path failed, in the backend's own words. Shown in place of
	 *  the generic copy on the unreachable card so a 404 on the release asset or a
	 *  failed write names itself instead of reading as "something went wrong". */
	localError?: string | null;
	/** The local path is unreachable: no Core answered on the local node, and (on
	 *  desktop) starting one failed. On the webapp this swaps the local card for an
	 *  install prompt so the user is never sent into an app whose backend does not
	 *  exist; on desktop it offers a retry. */
	localUnreachable?: boolean;
	/** Managed adoption is in flight (polling the control plane for a node). */
	managedBusy?: boolean;
	/** Whether the org's plan includes managed inference (WS8). Drives the
	 *  managed option's affordance on the `choose` step: entitled shows a live
	 *  CTA, otherwise it reads as an upsell that deep-links to pricing. */
	managedEntitled?: boolean;
	/** The plan entitlement is still resolving; the managed CTA waits on it so an
	 *  entitled user is never briefly shown the upsell. */
	managedLoading?: boolean;
	/** Interactive mic-permission prompt, injected by the container as a slot
	 *  (the storyboard passes a static card). */
	micPrompt?: ReactNode;
	micSubmitting?: boolean;
	/** Leave the `connect` step and return to the `choose` fork. */
	onBackFromConnect?: () => void;
	/** Pick the local / bring-your-own-keys path on the `choose` step. */
	onChooseLocal?: () => void;
	/** Pick the managed (Ryu Cloud) path on the `choose` step. */
	onChooseManaged?: () => void;
	/** Pick "connect to an existing node" on the `choose` step — opens the
	 *  `connect` form rather than committing to anything. */
	onChooseRemote?: () => void;
	onClearAllSkillPacks?: () => void;
	/** Submit the `connect` form: probe `url`, then adopt it as the active node.
	 *  `token` is optional (a node with auth off accepts an empty one). */
	onConnectRemote?: (url: string, token: string) => void;
	onContinueAgents?: () => void;
	onContinueMic?: () => void;
	onContinueSkillPacks?: () => void;
	/** Open the desktop-app download page (webapp, local unreachable). */
	onDownloadDesktop?: () => void;
	/** Keep the current feature on and advance to the next step. */
	onEnableFeature?: () => void;
	/** Re-run the agent lookup from the `agents` step's failure notice. */
	onRetryAgents?: () => void;
	onRetrySkillPacks?: () => void;
	onSelectAllSkillPacks?: () => void;
	onSkipAgents?: () => void;
	/** Turn the current feature off (hides its sidebar section) and advance. */
	onSkipFeature?: () => void;
	onSkipMic?: () => void;
	onToggleAgent?: (id: string) => void;
	onToggleSkillPack?: (id: string) => void;
	/** 0–100 progress for the auto-advancing steps, derived from the phase by the
	 *  container. Drives the real Progress bar on starting/installing/finishing. */
	progress?: number;
	/** The `connect` form is probing the URL the user typed. */
	remoteChecking?: boolean;
	/** Why the last connect attempt failed, shown under the form. Null clears it. */
	remoteError?: string | null;
	/** Ids of the currently-selected agents. */
	selected?: ReadonlySet<string>;
	/** The optional skill collections currently selected for installation. */
	selectedSkillPackIds?: ReadonlySet<string>;
	/** Optional external skill collections available for this node. */
	skillPacks?: OnboardingSkillPackOption[];
	/** Whether the current caller may save the node-scoped selection. */
	skillPacksCanConfigure?: boolean;
	/** A previous skill-pack catalog or save request failed. */
	skillPacksError?: string | null;
	/** The skill-pack catalog is loading from the active node. */
	skillPacksLoading?: boolean;
	skillPacksSubmitting?: boolean;
	step: OnboardingStep;
	/** Supporting line under the title (login-style PageHeader). */
	subtitle?: string;
	/** A curated set of popular agents the user can opt into, shown under the
	 *  "Suggested" header on the `agents` step (not pre-selected). */
	suggestedAgents?: OnboardingAgentOption[];
	/** Main heading (login-style PageHeader title). On the auto-advancing
	 *  `starting`/`installing`/`finishing` steps this is the rotating loading
	 *  copy, swapped in place via TextSwap in the shell. */
	title: string;
}
