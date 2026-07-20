"use client";

// Presentational layer of the desktop Onboarding wizard. The live app
// (`apps/desktop/src/pages/OnboardingPage.tsx`) is a thin container that polls
// Core's catalog, detects installable CLI agents, and drives the phase machine,
// then renders this view with the resolved state + real handlers; the storyboard
// renders the same component with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.
//
// Like the `AgentsView` / login reference, the real page's bespoke
// framer-motion mount transitions are intentionally dropped — `motion` is not
// resolvable at the shared block boundary.

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Logo as GhostOrb } from "@ryu/ui/components/logo";
import { Progress, ProgressValue } from "@ryu/ui/components/progress";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
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
 *  bar; `agents`, `features`, and `mic` are the interactive steps. */
export type OnboardingStep =
	| "starting"
	| "choose"
	| "installing"
	| "agents"
	| "features"
	| "mic"
	| "finishing"
	| "done";

/** The status line under the title for each step. The container maps its own
 *  phase enum onto these. */
export interface OnboardingViewProps {
	/** Agents found on the user's system (detected on PATH), shown under the
	 *  "Found on your system" header on the `agents` step and pre-selected. */
	agents?: OnboardingAgentOption[];
	/** The single feature shown on the current `features` step (one per step). */
	currentFeature?: OnboardingFeatureOption;
	/** 1-based position of the current feature step (e.g. 2 of 4). */
	featureStepIndex?: number;
	/** Total number of feature steps, for the "X of Y" progress hint. */
	featureStepTotal?: number;
	/** A local reachability probe is in flight (the card shows a checking state). */
	localChecking?: boolean;
	/** The local path is unreachable: no Core answered on the local node. Only the
	 *  webapp can reach this state — the desktop gates the `choose` step on its own
	 *  Core already running. Swaps the local card for an install prompt so the user
	 *  is never sent into an app whose backend does not exist. */
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
	/** Pick the local / bring-your-own-keys path on the `choose` step. */
	onChooseLocal?: () => void;
	/** Pick the managed (Ryu Cloud) path on the `choose` step. */
	onChooseManaged?: () => void;
	onContinueAgents?: () => void;
	onContinueMic?: () => void;
	/** Open the desktop-app download page (webapp, local unreachable). */
	onDownloadDesktop?: () => void;
	/** Keep the current feature on and advance to the next step. */
	onEnableFeature?: () => void;
	onSkipAgents?: () => void;
	/** Turn the current feature off (hides its sidebar section) and advance. */
	onSkipFeature?: () => void;
	onSkipMic?: () => void;
	onToggleAgent?: (id: string) => void;
	/** 0–100 progress for the auto-advancing steps, derived from the phase by the
	 *  container. Drives the real Progress bar on starting/installing/finishing. */
	progress?: number;
	/** Ids of the currently-selected agents. */
	selected?: ReadonlySet<string>;
	statusMessage: string;
	step: OnboardingStep;
	/** A curated set of popular agents the user can opt into, shown under the
	 *  "Suggested" header on the `agents` step (not pre-selected). */
	suggestedAgents?: OnboardingAgentOption[];
}

function OnboardingShell({
	statusMessage,
	children,
}: {
	statusMessage: string;
	children?: ReactNode;
}) {
	return (
		// The shell fills the window and sits on top of the page wrapper, so the
		// drag region has to live here (as it does on LoginView) — otherwise this
		// covers the wrapper's region and the onboarding window can't be dragged on
		// macOS. Interactive children (buttons) override it, so only the empty
		// surround drags the window.
		<div
			className="flex h-full w-full flex-col items-center justify-center gap-8 p-8"
			data-tauri-drag-region="true"
		>
			<StaggerReveal>
				<div className="shrink-0">
					<GhostOrb size="50px" variant="outline" />
				</div>
				<div className="space-y-1 text-left">
					<p className="max-w-md text-left font-medium text-muted-foreground text-xl">
						{statusMessage}
					</p>
				</div>
				{children}
			</StaggerReveal>
		</div>
	);
}

/** Progress bar shown on the auto-advancing steps. Uses the shared shadcn/base-ui
 *  Progress with a real percentage the container derives from the onboarding
 *  phase, so it fills as setup actually advances instead of showing a generic
 *  animation. `done` pins it to 100%. */
function ProgressBar({ value, done }: { value?: number; done?: boolean }) {
	const pct = done ? 100 : Math.max(0, Math.min(100, value ?? 0));
	return (
		<div className="flex w-60 flex-col gap-1.5">
			<Progress value={pct}>
				<ProgressValue />
			</Progress>
		</div>
	);
}

/** A single selectable agent row, shared by the "Found" and "Suggested"
 *  sections. The `Found` badge only renders for agents detected on PATH. */
function AgentRow({
	agent,
	isSelected,
	onToggleAgent,
}: {
	agent: OnboardingAgentOption;
	isSelected: boolean;
	onToggleAgent?: (id: string) => void;
}) {
	return (
		<button
			aria-pressed={isSelected}
			className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
				isSelected
					? "border-primary bg-primary/5"
					: "border-border hover:bg-muted/50"
			}`}
			onClick={() => onToggleAgent?.(agent.id)}
			type="button"
		>
			<span
				className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${
					isSelected
						? "border-primary bg-primary text-primary-foreground"
						: "border-muted-foreground/40"
				}`}
			>
				{isSelected ? (
					<HugeiconsIcon className="size-3.5" icon={Tick02Icon} />
				) : null}
			</span>
			<span className="min-w-0 flex-1">
				<span className="flex items-center gap-2">
					{agent.logo ? (
						<span className="flex size-5 shrink-0 items-center justify-center">
							{agent.logo}
						</span>
					) : null}
					<span className="font-medium">{agent.name}</span>
					{agent.detected ? (
						<Badge className="text-xs" variant="secondary">
							Found
						</Badge>
					) : null}
				</span>
				{agent.description ? (
					<span className="block truncate text-muted-foreground text-sm">
						{agent.description}
					</span>
				) : null}
			</span>
		</button>
	);
}

/** A titled group of agent rows. Renders nothing when the group is empty. */
function AgentSection({
	title,
	agents,
	selected,
	onToggleAgent,
}: {
	title: string;
	agents: OnboardingAgentOption[];
	selected?: ReadonlySet<string>;
	onToggleAgent?: (id: string) => void;
}) {
	if (agents.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-col gap-2">
			<p className="font-medium text-foreground text-sm">{title}</p>
			{agents.map((agent) => (
				<AgentRow
					agent={agent}
					isSelected={selected?.has(agent.id) ?? false}
					key={agent.id}
					onToggleAgent={onToggleAgent}
				/>
			))}
		</div>
	);
}

function AgentPicker({
	agents = [],
	suggestedAgents = [],
	selected,
	onToggleAgent,
	onSkipAgents,
	onContinueAgents,
}: Pick<
	OnboardingViewProps,
	| "agents"
	| "suggestedAgents"
	| "selected"
	| "onToggleAgent"
	| "onSkipAgents"
	| "onContinueAgents"
>) {
	const selectedCount = selected?.size ?? 0;
	return (
		<div className="flex w-full max-w-md flex-col gap-3">
			{/* `scroll-fade-effect-y` (apps/desktop/src/index.css) fades the top/bottom
			    edges as you scroll, the same scroll-driven mask the rest of the app
			    uses for its lists. */}
			<div className="scroll-fade-effect-y -mr-1 flex max-h-[45vh] flex-col gap-4 overflow-y-auto pr-1">
				<AgentSection
					agents={agents}
					onToggleAgent={onToggleAgent}
					selected={selected}
					title="Found on your system"
				/>
				<AgentSection
					agents={suggestedAgents}
					onToggleAgent={onToggleAgent}
					selected={selected}
					title="Suggested"
				/>
			</div>

			<div className="mt-2 flex items-center justify-end gap-2">
				<Button onClick={onSkipAgents} size="sm" variant="ghost">
					Skip
				</Button>
				<Button onClick={onContinueAgents} size="lg" variant="mono">
					{selectedCount > 0 ? `Add ${selectedCount} & continue` : "Continue"}
				</Button>
			</div>
		</div>
	);
}

// One feature per step: each optional feature gets its own screen explaining what
// it's for, with Enable / Not now. "Not now" hides that feature's sidebar section;
// either choice advances to the next feature (then the mic step).
function FeatureStep({
	currentFeature,
	featureStepIndex,
	featureStepTotal,
	onEnableFeature,
	onSkipFeature,
}: Pick<
	OnboardingViewProps,
	| "currentFeature"
	| "featureStepIndex"
	| "featureStepTotal"
	| "onEnableFeature"
	| "onSkipFeature"
>) {
	if (!currentFeature) {
		return null;
	}
	return (
		<div className="flex w-full max-w-md flex-col gap-4">
			{featureStepIndex && featureStepTotal ? (
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Feature {featureStepIndex} of {featureStepTotal}
				</p>
			) : null}

			<div className="rounded-lg bg-muted/40 p-4 text-left">
				<p className="font-semibold text-lg">{currentFeature.name}</p>
				<p className="mt-1 text-muted-foreground text-sm">
					{currentFeature.description}
				</p>
			</div>

			<p className="text-muted-foreground text-xs">
				Turn it off and it's simply hidden from the sidebar — you can turn it
				back on anytime in Settings → Features.
			</p>

			<div className="mt-1 flex items-center justify-end gap-2">
				<Button onClick={onSkipFeature} size="sm" variant="ghost">
					Not now
				</Button>
				<Button onClick={onEnableFeature} size="lg" variant="mono">
					Enable
				</Button>
			</div>
		</div>
	);
}

// The managed-vs-local fork (WS8). Local is the primary, always-available path
// (BYO keys / on-device); managed (Ryu Cloud) is gated on the plan entitlement.
// When not entitled the managed button reads as an upsell and its handler
// deep-links to web pricing instead of proceeding. No key material is touched
// here, and picking managed never provisions a server from the desktop.
function ChooseStep({
	localChecking,
	localUnreachable,
	managedEntitled,
	managedBusy,
	managedLoading,
	onChooseLocal,
	onChooseManaged,
	onDownloadDesktop,
}: Pick<
	OnboardingViewProps,
	| "localChecking"
	| "localUnreachable"
	| "managedEntitled"
	| "managedBusy"
	| "managedLoading"
	| "onChooseLocal"
	| "onChooseManaged"
	| "onDownloadDesktop"
>) {
	let managedLabel = "Use Ryu Cloud";
	if (managedBusy) {
		managedLabel = "Connecting…";
	} else if (managedLoading) {
		managedLabel = "Checking your plan…";
	} else if (!managedEntitled) {
		managedLabel = "Upgrade to unlock";
	}
	const showProBadge = !(managedEntitled || managedLoading);

	return (
		<div className="flex w-full max-w-md flex-col gap-3">
			{localUnreachable ? (
				<div className="rounded-lg border border-border p-4 text-left">
					<p className="font-semibold text-lg">No local node detected</p>
					<p className="mt-1 text-muted-foreground text-sm">
						Running your own models needs the Ryu desktop app on this machine —
						it is what hosts the local node this page talks to. Install it, then
						retry.
					</p>
					<Button
						className="mt-3 w-full"
						onClick={onDownloadDesktop}
						size="lg"
						variant="mono"
					>
						Download the desktop app
					</Button>
					<Button
						className="mt-2 w-full"
						disabled={localChecking}
						onClick={onChooseLocal}
						size="lg"
						variant="outline"
					>
						{localChecking ? "Checking…" : "Retry"}
					</Button>
				</div>
			) : (
				<div className="rounded-lg border border-border p-4 text-left">
					<p className="font-semibold text-lg">Bring your own keys</p>
					<p className="mt-1 text-muted-foreground text-sm">
						Run models on this device or connect your own API keys. Private,
						free, and works offline.
					</p>
					<Button
						className="mt-3 w-full"
						disabled={localChecking}
						onClick={onChooseLocal}
						size="lg"
						variant="mono"
					>
						{localChecking
							? "Checking for a local node…"
							: "Continue with local"}
					</Button>
				</div>
			)}

			<div className="rounded-lg border border-border p-4 text-left">
				<div className="flex items-center gap-2">
					<p className="font-semibold text-lg">Use Ryu Cloud</p>
					{showProBadge ? (
						<Badge className="text-xs" variant="secondary">
							Pro
						</Badge>
					) : null}
				</div>
				<p className="mt-1 text-muted-foreground text-sm">
					Managed inference on Ryu-hosted servers. Nothing to install;
					provisioning and billing stay on the web.
				</p>
				<Button
					className="mt-3 w-full"
					disabled={managedBusy || managedLoading}
					onClick={onChooseManaged}
					size="lg"
					variant="outline"
				>
					{managedLabel}
				</Button>
			</div>
		</div>
	);
}

function MicStep({
	micPrompt,
	micSubmitting,
	onSkipMic,
	onContinueMic,
}: Pick<
	OnboardingViewProps,
	"micPrompt" | "micSubmitting" | "onSkipMic" | "onContinueMic"
>) {
	return (
		<div className="flex w-full max-w-md flex-col gap-4">
			<p className="text-muted-foreground text-sm">
				Want to talk to your agents? Enable the microphone for voice input. You
				can always do this later from Settings.
			</p>

			{micPrompt}

			<div className="mt-2 flex items-center justify-end gap-2">
				<Button
					disabled={micSubmitting}
					onClick={onSkipMic}
					size="sm"
					variant="ghost"
				>
					Skip
				</Button>
				<Button
					disabled={micSubmitting}
					onClick={onContinueMic}
					size="lg"
					variant="mono"
				>
					Continue
				</Button>
			</div>
		</div>
	);
}

export function OnboardingView(props: OnboardingViewProps) {
	const { step, statusMessage } = props;

	if (step === "choose") {
		return (
			<OnboardingShell statusMessage={statusMessage}>
				<ChooseStep {...props} />
			</OnboardingShell>
		);
	}

	if (step === "agents") {
		return (
			<OnboardingShell statusMessage={statusMessage}>
				<AgentPicker {...props} />
			</OnboardingShell>
		);
	}

	if (step === "features") {
		return (
			<OnboardingShell statusMessage={statusMessage}>
				<FeatureStep {...props} />
			</OnboardingShell>
		);
	}

	if (step === "mic") {
		return (
			<OnboardingShell statusMessage={statusMessage}>
				<MicStep {...props} />
			</OnboardingShell>
		);
	}

	return (
		<OnboardingShell statusMessage={statusMessage}>
			<ProgressBar done={step === "done"} value={props.progress} />
		</OnboardingShell>
	);
}
