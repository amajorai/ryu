"use client";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { OnboardingActions, OnboardingCta } from "./onboarding-shell.tsx";
import type {
	OnboardingAgentOption,
	OnboardingViewProps,
} from "./onboarding-types.ts";

/** One selectable row: a check, the logo and name, and one description line.
 *  In a multi-select list the check alone carries the on state, so a fully
 *  selected list does not turn into a stack of filled boxes. */
export function OnboardingCheckRow({
	children,
	className,
	disabled,
	isSelected,
	onToggle,
	testId,
}: {
	children: ReactNode;
	className?: string;
	disabled?: boolean;
	isSelected: boolean;
	onToggle?: () => void;
	testId?: string;
}) {
	return (
		<button
			aria-pressed={isSelected}
			className={cn(
				"flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150 hover:duration-0 disabled:opacity-50",
				"hover:bg-muted",
				className
			)}
			data-testid={testId}
			disabled={disabled}
			onClick={onToggle}
			type="button"
		>
			<span
				className={cn(
					"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
					isSelected
						? "border-primary bg-primary text-primary-foreground"
						: "border-border"
				)}
			>
				{isSelected ? (
					<HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} />
				) : null}
			</span>
			<span className="min-w-0 flex-1">{children}</span>
		</button>
	);
}

/** A single selectable agent row, shared by the "Found" and "Suggested"
 *  sections; the section title already says which agents were detected. */
export function AgentRow({
	agent,
	isSelected,
	onToggleAgent,
}: {
	agent: OnboardingAgentOption;
	isSelected: boolean;
	onToggleAgent?: (id: string) => void;
}) {
	return (
		<OnboardingCheckRow
			isSelected={isSelected}
			onToggle={() => onToggleAgent?.(agent.id)}
		>
			<span className="flex items-center gap-2">
				{agent.logo ? (
					<span className="flex size-5 shrink-0 items-center justify-center">
						{agent.logo}
					</span>
				) : null}
				<span className="font-medium text-sm">{agent.name}</span>
			</span>
			{agent.description ? (
				<span
					className="block truncate text-detail text-muted-foreground"
					title={agent.description}
				>
					{agent.description}
				</span>
			) : null}
		</OnboardingCheckRow>
	);
}

/** A titled group of agent rows. Renders nothing when the group is empty. */
export function AgentSection({
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
		<div className="flex flex-col gap-1">
			<p className="mb-1 px-3 font-semibold text-foreground text-sm">{title}</p>
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

export function AgentPicker({
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
	const tl = useLiteralMessages();
	const selectedCount = selected?.size ?? 0;
	// Nothing to offer: every curated agent is already added (the lists exclude
	// added ones). The step still shows — it is a step, not a query result — but a
	// header over a blank area reads as broken, so it says why it is empty.
	const isEmpty = agents.length === 0 && suggestedAgents.length === 0;
	return (
		<>
			{/* The shell owns scrolling (see OnboardingShell). Nesting a max-height
			    scroller here fought the page scroll and left the list feeling stuck. */}
			<div className="flex flex-col gap-6">
				{agentsUnavailable ? (
					<div className="flex items-center gap-3 px-3">
						<p className="flex-1 text-detail text-muted-foreground">
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
						className="text-center text-detail text-muted-foreground"
						data-testid="agents-empty"
					>
						Every agent we suggest is already set up on this device. You can add
						more any time from the Store.
					</p>
				) : null}
			</div>

			<OnboardingActions className="sticky bottom-0 bg-background py-2">
				<OnboardingCta onClick={onSkipAgents} tone="secondary">
					Skip
				</OnboardingCta>
				<OnboardingCta onClick={onContinueAgents}>
					{selectedCount > 0
						? tl("Add {selectedCount} & continue", { selectedCount })
						: "Continue"}
				</OnboardingCta>
			</OnboardingActions>
		</>
	);
}
