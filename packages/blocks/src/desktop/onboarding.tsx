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
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Logo as GhostOrb } from "@ryu/ui/components/logo";
import { PageHeader } from "@ryu/ui/components/page-header";
import {
	STAGGER_STEP_MS,
	StaggerReveal,
} from "@ryu/ui/components/stagger-reveal";
import { TextSwap } from "@ryu/ui/components/text-swap";
import { MetalFx } from "metal-fx";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";

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
	| "connect"
	| "installing"
	| "agents"
	| "features"
	| "mic"
	| "finishing"
	| "done";

/** Login-style PageHeader copy for each step. The container maps its phase
 *  onto `title` + optional `subtitle` (rotating loading lines use subtitle). */
export interface OnboardingViewProps {
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
	/** Submit the `connect` form: probe `url`, then adopt it as the active node.
	 *  `token` is optional (a node with auth off accepts an empty one). */
	onConnectRemote?: (url: string, token: string) => void;
	onContinueAgents?: () => void;
	onContinueMic?: () => void;
	/** Open the desktop-app download page (webapp, local unreachable). */
	onDownloadDesktop?: () => void;
	/** Keep the current feature on and advance to the next step. */
	onEnableFeature?: () => void;
	/** Re-run the agent lookup from the `agents` step's failure notice. */
	onRetryAgents?: () => void;
	onSkipAgents?: () => void;
	/** Turn the current feature off (hides its sidebar section) and advance. */
	onSkipFeature?: () => void;
	onSkipMic?: () => void;
	onToggleAgent?: (id: string) => void;
	/** 0–100 progress for the auto-advancing steps, derived from the phase by the
	 *  container. Drives the real Progress bar on starting/installing/finishing. */
	progress?: number;
	/** The `connect` form is probing the URL the user typed. */
	remoteChecking?: boolean;
	/** Why the last connect attempt failed, shown under the form. Null clears it. */
	remoteError?: string | null;
	/** Ids of the currently-selected agents. */
	selected?: ReadonlySet<string>;
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

/**
 * Where a step's content picks the cascade back up. The shell's own reveal
 * spends two slots — the orb, then the header — so the first content line lands
 * on slot three and every line under it keeps the same 40ms rhythm. Exported
 * because the desktop-only steps (theme / preferences / privacy) mirror this
 * shell rather than rendering through it, and a second hand-picked delay there
 * is how the two halves of onboarding drift apart.
 */
export const ONBOARDING_CONTENT_DELAY_MS = 2 * STAGGER_STEP_MS;

function OnboardingShell({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle?: string;
	children?: ReactNode;
}) {
	return (
		// The shell fills the window and sits on top of the page wrapper, so the
		// drag region has to live here (as it does on LoginView) — otherwise this
		// covers the wrapper's region and the onboarding window can't be dragged on
		// macOS. Interactive children (buttons) override it, so only the empty
		// surround drags the window.
		//
		// Outer wrapper owns the scroll; the inner column uses `min-h-full` (not
		// `h-full`) so it stays vertically centered when the content fits and grows
		// past the viewport when it doesn't — the parent PageWrapper is
		// `h-screen overflow-hidden`, so without this a long step (e.g. the agent
		// picker with many rows) pushed its Continue button off the bottom edge with
		// no way to scroll to it.
		<div className="scroll-fade h-full w-full overflow-y-auto">
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="shrink-0">
						<GhostOrb size="50px" variant="outline" />
					</div>
					{/* Same title + muted subtitle stack as LoginView's PageHeader.
				    TextSwap keeps rotating loading lines from hard-cutting. */}
					<PageHeader
						stagger={false}
						subtitle={subtitle ? <TextSwap>{subtitle}</TextSwap> : undefined}
						title={<TextSwap>{title}</TextSwap>}
					/>
				</StaggerReveal>
				{/* Deliberately OUTSIDE that reveal. Each step runs its own
				    `StaggerReveal` at `ONBOARDING_CONTENT_DELAY_MS` so its rows cascade
				    one after another instead of arriving as one block; revealing the
				    step's container here as well would compound the two — the travel
				    and the blur would both be applied twice to the same rows. Keeping
				    the step's own reveal inside the step is also what makes each
				    STEP re-animate: the shell never unmounts across phases, so a
				    cascade owned by it would only ever play on the first screen. */}
				{children}
			</div>
		</div>
	);
}

/** Soft ceiling for the fake crawl so a long wait never claims "almost done"
 *  (and so the next phase jump still reads as forward motion). */
function progressCrawlCeiling(floor: number): number {
	if (floor >= 90) {
		return 98;
	}
	if (floor >= 50) {
		return 88;
	}
	return 50;
}

const PROGRESS_CRAWL_MS = 3500;

/** Progress bar shown on the auto-advancing steps. The phase-derived percentage
 *  is the floor; a +1 crawl every few seconds inches toward a soft ceiling so
 *  the bar never looks frozen during long waits (local install can take minutes).
 *  A continuously-sweeping marquee (`t-progress-marquee`) rides inside the fill
 *  for extra motion. The marquee is clipped to the filled portion only. `done`
 *  pins to 100% and drops the motion. Styling mirrors the shared Progress
 *  track/indicator (`h-3`, `rounded-full`, `bg-muted`/`bg-primary`). */
function ProgressBar({ value, done }: { value?: number; done?: boolean }) {
	const floor = Math.max(0, Math.min(100, value ?? 0));
	const [display, setDisplay] = useState(floor);

	// Snap up when the phase advances past where the crawl has reached.
	useEffect(() => {
		setDisplay((prev) => Math.max(prev, floor));
	}, [floor]);

	// Fake crawl: +1 every few seconds, capped below the next phase jump.
	useEffect(() => {
		if (done) {
			return;
		}
		const ceiling = progressCrawlCeiling(floor);
		const id = setInterval(() => {
			setDisplay((prev) => {
				if (prev >= ceiling) {
					return prev;
				}
				return Math.min(ceiling, prev + 1);
			});
		}, PROGRESS_CRAWL_MS);
		return () => clearInterval(id);
	}, [done, floor]);

	const pct = done ? 100 : display;
	return (
		<div className="flex w-60 flex-col gap-1.5">
			<div
				aria-label="Setting up"
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={Math.round(pct)}
				className="t-progress-track relative h-3 w-full overflow-hidden rounded-full bg-muted"
				role="progressbar"
			>
				<div
					className="relative h-full overflow-hidden rounded-full bg-primary transition-[width] duration-700 ease-out"
					style={{ width: `${pct}%` }}
				>
					{done ? null : (
						<span aria-hidden="true" className="t-progress-marquee" />
					)}
				</div>
			</div>
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
			className={`flex items-start gap-3 rounded-4xl p-3 text-left transition-colors ${
				isSelected ? "bg-primary/10" : "bg-card hover:bg-muted/50"
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
	agentsRetrying,
	agentsUnavailable,
	suggestedAgents = [],
	selected,
	onRetryAgents,
	onToggleAgent,
	onSkipAgents,
	onContinueAgents,
}: Pick<
	OnboardingViewProps,
	| "agents"
	| "agentsRetrying"
	| "agentsUnavailable"
	| "suggestedAgents"
	| "selected"
	| "onRetryAgents"
	| "onToggleAgent"
	| "onSkipAgents"
	| "onContinueAgents"
>) {
	const selectedCount = selected?.size ?? 0;
	// Nothing to offer: every curated agent is already added (the lists exclude
	// added ones). The step still shows — it is a step, not a query result — but a
	// header over a blank area reads as broken, so it says why it is empty.
	const isEmpty = agents.length === 0 && suggestedAgents.length === 0;
	return (
		<div className="flex w-full max-w-md flex-col gap-3">
			<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS}>
				{/* The shell owns scrolling (see OnboardingShell). Nesting a max-height
				    scroller here fought the page scroll and left the list feeling stuck. */}
				<div className="flex flex-col gap-4">
					{agentsUnavailable ? (
						<div className="flex items-center gap-3 rounded-4xl bg-card p-3">
							<p className="flex-1 text-muted-foreground text-xs">
								Couldn't check what's already installed on this device. You can
								still pick from the list below.
							</p>
							<Button
								disabled={agentsRetrying}
								onClick={onRetryAgents}
								size="sm"
								type="button"
								variant="outline"
							>
								{agentsRetrying ? "Checking…" : "Retry"}
							</Button>
						</div>
					) : null}
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
					{isEmpty ? (
						<p
							className="text-muted-foreground text-xs"
							data-testid="agents-empty"
						>
							Every agent we suggest is already set up on this device. You can
							add more any time from the Store.
						</p>
					) : null}
				</div>

				<div className="sticky bottom-0 mt-2 flex items-center justify-end gap-2 bg-background/80 py-2 backdrop-blur-sm">
					<Button onClick={onSkipAgents} size="sm" variant="ghost">
						Skip
					</Button>
					<Button onClick={onContinueAgents} size="lg" variant="mono">
						{selectedCount > 0 ? `Add ${selectedCount} & continue` : "Continue"}
					</Button>
				</div>
			</StaggerReveal>
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
			{/* Keyed on the feature index: every feature is the same component in the
			    same slot, so without a key React reuses the reveal that has already
			    played and features 2..n would snap in with no cascade at all. */}
			<StaggerReveal
				key={featureStepIndex}
				startDelay={ONBOARDING_CONTENT_DELAY_MS}
			>
				{featureStepIndex && featureStepTotal ? (
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Feature {featureStepIndex} of {featureStepTotal}
					</p>
				) : null}

				<div className="rounded-lg bg-muted/40 p-4 text-left">
					<p className="font-medium text-lg">{currentFeature.name}</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{currentFeature.description}
					</p>
				</div>

				<p className="text-muted-foreground text-xs">
					Turn it off and it's simply hidden from the sidebar. You can turn it
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
			</StaggerReveal>
		</div>
	);
}

// The runtime-choice fork (WS8). Local is the primary, always-available path
// (BYO keys / on-device); Ryu Cloud is gated on the plan entitlement. When not
// entitled, its button opens web pricing instead of provisioning anything.
// No key material is touched here, and choosing Cloud never provisions a server
// from the desktop.
function ChooseStep({
	isDesktop,
	localChecking,
	localError,
	localUnreachable,
	managedEntitled,
	managedBusy,
	managedLoading,
	onChooseLocal,
	onChooseManaged,
	onChooseRemote,
	onDownloadDesktop,
}: Pick<
	OnboardingViewProps,
	| "isDesktop"
	| "localChecking"
	| "localError"
	| "localUnreachable"
	| "managedEntitled"
	| "managedBusy"
	| "managedLoading"
	| "onChooseLocal"
	| "onChooseManaged"
	| "onChooseRemote"
	| "onDownloadDesktop"
>) {
	let managedLabel = "Use Ryu Cloud";
	if (managedBusy) {
		managedLabel = "Connecting…";
	} else if (managedLoading) {
		managedLabel = "Checking your plan…";
	} else if (!managedEntitled) {
		managedLabel = "See team plans";
	}
	const isManagedUpsell = !(managedEntitled || managedLoading);
	// On desktop the local pick installs and starts Core, so "Checking…" would
	// understate a download that can take a while; the webapp only probes.
	let localCta = "Set up locally";
	if (localChecking) {
		localCta = isDesktop ? "Setting up…" : "Checking…";
	}
	const { resolvedTheme } = useTheme();
	const metalTheme = resolvedTheme === "light" ? "light" : "dark";

	// Inside the MetalFx frame the text color belongs to the shader's root, not
	// the outline variant — without this pin, the variant's `hover:text-foreground`
	// snaps the label to the theme's foreground (black in light mode) on hover.
	const managedButton = (
		<Button
			className={isManagedUpsell ? "hover:!text-inherit w-full" : "w-full"}
			disabled={managedBusy || managedLoading}
			onClick={onChooseManaged}
			size="lg"
			variant="outline"
		>
			{managedLabel}
		</Button>
	);

	// The choose step is a game-lobby-style fork: three equal, tall cards make the
	// tradeoff legible at a glance and keep the managed option visually first.
	const card = "rounded-4xl bg-muted p-5 text-left";
	const cell = `${card} flex min-h-[360px] flex-col`;

	let localCard: ReactNode;
	if (localUnreachable && isDesktop) {
		localCard = (
			<div className={cell} data-testid="onboarding-local-choice">
				<CardHeader eyebrow="On this device" title="Couldn't start local AI" />
				<p className="mt-1 text-muted-foreground text-sm">
					Try again, or choose another option.
				</p>
				{/* The backend's own message, kept verbatim under the friendly line
				    rather than replacing it: it is the only clue distinguishing a 404
				    on the release asset from a full disk, and it is a URL, so it needs
				    `break-all` or it runs straight out of the card. */}
				{localError ? (
					<p className="mt-2 break-all text-muted-foreground/70 text-xs">
						{localError}
					</p>
				) : null}
				<div className="mt-auto pt-3">
					<Button
						className="w-full"
						disabled={localChecking}
						onClick={onChooseLocal}
						size="lg"
						variant="mono"
					>
						{localChecking ? "Starting…" : "Try again"}
					</Button>
				</div>
			</div>
		);
	} else if (localUnreachable) {
		localCard = (
			<div className={cell} data-testid="onboarding-local-choice">
				<CardHeader eyebrow="On this device" title="Desktop app needed" />
				<p className="mt-1 text-muted-foreground text-sm">
					Install the Ryu desktop app to run AI here.
				</p>
				<div className="mt-auto pt-3">
					<Button
						className="w-full"
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
			</div>
		);
	} else {
		localCard = (
			<div className={cell} data-testid="onboarding-local-choice">
				<CardHeader eyebrow="On this device" title="Set it up yourself" />
				<p className="mt-1 text-muted-foreground text-sm">
					Private and offline. You manage downloads, updates, and performance.
				</p>
				<div className="mt-auto pt-3">
					<Button
						className="w-full"
						disabled={localChecking}
						onClick={onChooseLocal}
						size="lg"
						variant="mono"
					>
						{localCta}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="grid w-full max-w-4xl grid-cols-1 gap-4 md:grid-cols-3">
			<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS}>
				<div
					className={`${cell} border-primary/20 bg-card shadow-sm`}
					data-testid="onboarding-cloud-choice"
				>
					<CardHeader eyebrow="Ryu Cloud" title="Let Ryu handle it" />
					<p className="mt-1 text-muted-foreground text-sm">
						Ryu handles downloads, updates, and the server. Start working right
						away.
					</p>
					<div className="mt-auto pt-6">
						{isManagedUpsell ? (
							<MetalFx
								className="w-full"
								preset="chromatic"
								strength={0.9}
								theme={metalTheme}
								variant="button"
							>
								{managedButton}
							</MetalFx>
						) : (
							managedButton
						)}
					</div>
				</div>

				{localCard}

				<div className={cell} data-testid="onboarding-existing-node-choice">
					<CardHeader
						eyebrow="Your team’s server"
						title="Bring your own server"
					/>
					<p className="mt-1 text-muted-foreground text-sm">
						Connect to a server your team runs. Your team handles updates and
						access.
					</p>
					<div className="mt-auto pt-3">
						<Button
							className="w-full"
							onClick={onChooseRemote}
							size="lg"
							variant="outline"
						>
							Connect a server
						</Button>
					</div>
				</div>
			</StaggerReveal>
		</div>
	);
}

function CardHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
	return (
		<div className="space-y-1">
			<p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
				{eyebrow}
			</p>
			<PageHeader
				as="h2"
				stagger={false}
				title={title}
				titleClassName="font-medium text-lg"
			/>
		</div>
	);
}

// The `connect` step: address + optional token for a Core the user already runs.
// The container owns the probe; this only collects and reports. The URL is the
// only required field — a node with auth off accepts an empty token, and a wrong
// one surfaces as `remoteError` rather than being guessed at here.
function ConnectStep({
	onBackFromConnect,
	onConnectRemote,
	remoteChecking,
	remoteError,
}: Pick<
	OnboardingViewProps,
	"onBackFromConnect" | "onConnectRemote" | "remoteChecking" | "remoteError"
>) {
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const trimmedUrl = url.trim();
	const submit = () => {
		if (remoteChecking || trimmedUrl === "") {
			return;
		}
		onConnectRemote?.(trimmedUrl, token.trim());
	};

	return (
		<form
			className="flex w-full max-w-md flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS}>
				{/* Both fields carry their name in the placeholder, the way the sign-in
				    form does — the labels stay in the tree but visually hidden, because a
				    placeholder is not an accessible name and vanishes as soon as the user
				    types. The example address and the "optional" qualifier move into the
				    hint below each field, which is where they still read once the
				    placeholder is gone. */}
				<div className="flex flex-col gap-2">
					<Label className="sr-only" htmlFor="onboarding-node-url">
						Node address
					</Label>
					<Input
						autoComplete="off"
						autoFocus
						id="onboarding-node-url"
						onChange={(e) => setUrl(e.target.value)}
						placeholder="Node address"
						size="lg"
						spellCheck={false}
						value={url}
					/>
					<p className="text-muted-foreground text-xs">
						The address of the machine running Ryu Core, including the port —
						for example http://192.168.1.20:7980.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					<Label className="sr-only" htmlFor="onboarding-node-token">
						Access token
					</Label>
					<Input
						autoComplete="off"
						id="onboarding-node-token"
						onChange={(e) => setToken(e.target.value)}
						placeholder="Access token"
						size="lg"
						spellCheck={false}
						type="password"
						value={token}
					/>
					<p className="text-muted-foreground text-xs">
						Optional — leave empty if the node has no token. Whoever runs the
						node can read it from their Ryu settings.
					</p>
				</div>

				{remoteError ? (
					<p className="text-destructive text-sm">{remoteError}</p>
				) : null}

				<div className="mt-1 flex items-center justify-end gap-2">
					<Button
						disabled={remoteChecking}
						onClick={onBackFromConnect}
						size="sm"
						type="button"
						variant="ghost"
					>
						Back
					</Button>
					<Button
						disabled={remoteChecking || trimmedUrl === ""}
						size="lg"
						type="submit"
						variant="mono"
					>
						{remoteChecking ? "Connecting…" : "Connect"}
					</Button>
				</div>
			</StaggerReveal>
		</form>
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
			{/* `wrap`: `micPrompt` is whatever the container hands in, so there is no
			    guarantee it forwards className/style to its own root. */}
			<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS} wrap>
				<p className="text-muted-foreground text-sm">
					Ryu can listen when you want to talk to your agents. You can always
					change this later in Settings.
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
						{micSubmitting ? "Requesting…" : "Allow"}
					</Button>
				</div>
			</StaggerReveal>
		</div>
	);
}

export function OnboardingView(props: OnboardingViewProps) {
	const { step, title, subtitle } = props;

	// Agents step: when we detected installs, lead with that — otherwise a
	// generic pick-your-agents prompt. Overrides the container's default copy.
	let headerTitle = title;
	let headerSubtitle = subtitle;
	if (step === "agents") {
		const detectedCount = props.agents?.length ?? 0;
		if (detectedCount > 0) {
			headerTitle = "We found agents on this device";
			headerSubtitle = "Pick which ones to add, and install more later";
		} else {
			headerTitle = "Add your agents";
			headerSubtitle = "Pick any you'd like to set up, and install more later";
		}
	}

	if (step === "choose") {
		return (
			<OnboardingShell subtitle={headerSubtitle} title={headerTitle}>
				<ChooseStep {...props} />
			</OnboardingShell>
		);
	}

	if (step === "connect") {
		return (
			<OnboardingShell subtitle={headerSubtitle} title={headerTitle}>
				<ConnectStep {...props} />
			</OnboardingShell>
		);
	}

	if (step === "agents") {
		return (
			<OnboardingShell subtitle={headerSubtitle} title={headerTitle}>
				<AgentPicker {...props} />
			</OnboardingShell>
		);
	}

	if (step === "features") {
		return (
			<OnboardingShell subtitle={headerSubtitle} title={headerTitle}>
				<FeatureStep {...props} />
			</OnboardingShell>
		);
	}

	if (step === "mic") {
		return (
			<OnboardingShell subtitle={headerSubtitle} title={headerTitle}>
				<MicStep {...props} />
			</OnboardingShell>
		);
	}

	// The auto-advancing steps (starting / installing / finishing / done). The
	// shell no longer reveals its children, so the bar needs its own reveal or it
	// would be the one thing on screen that hard-cuts in.
	return (
		<OnboardingShell subtitle={headerSubtitle} title={headerTitle}>
			<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS} wrap>
				<ProgressBar done={step === "done"} value={props.progress} />
			</StaggerReveal>
		</OnboardingShell>
	);
}
