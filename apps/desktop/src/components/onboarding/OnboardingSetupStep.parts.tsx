import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { AgentSelectionField } from "@/components/agent-elements/input/agent-selection-field.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";
import type {
	OnboardingOrganization,
	OnboardingThreadGroup,
} from "./OnboardingSetupStep.types.ts";

export function Shell({
	title,
	subtitle,
	children,
}: {
	children: ReactNode;
	subtitle: string;
	title: string;
}) {
	return (
		<ActivationStepShell stepKey={title} subtitle={subtitle} title={title}>
			{children}
		</ActivationStepShell>
	);
}

export function ContinueRow({
	onContinue,
	onSkip,
	continueLabel = "Continue",
	skipLabel = "Skip for now",
	disabled = false,
}: {
	continueLabel?: string;
	disabled?: boolean;
	onContinue: () => void;
	onSkip?: () => void;
	skipLabel?: string;
}) {
	return (
		<OnboardingActions className="justify-between">
			{onSkip ? (
				<OnboardingCta disabled={disabled} onClick={onSkip} tone="secondary">
					{skipLabel}
				</OnboardingCta>
			) : (
				<span />
			)}
			<OnboardingCta disabled={disabled} onClick={onContinue}>
				{continueLabel}
			</OnboardingCta>
		</OnboardingActions>
	);
}

export function LanePicker({
	busy = false,
	error,
	cloud,
	selection,
	target,
	allowedAgentIds,
	allowedProviderIds,
	onChange,
	onContinue,
	onSkip,
}: {
	allowedAgentIds: readonly string[];
	allowedProviderIds?: readonly string[];
	busy?: boolean;
	cloud: boolean;
	error?: string | null;
	onChange: (selection: AgentSelection) => void;
	onContinue: () => void;
	onSkip?: () => void;
	selection: AgentSelection;
	target: ApiTarget;
}) {
	const isEmpty = !(
		selection.agent_id ||
		selection.model ||
		selection.provider
	);
	return (
		<div className="flex flex-col gap-4">
			<div>
				<p className="font-semibold text-sm">
					{cloud ? "Default cloud agent" : "Default local agent"}
				</p>
				<p className="mt-1 text-pretty text-detail text-muted-foreground">
					{cloud
						? "Normal chats use this lane when it is configured. ACP agents keep their own model and permissions."
						: "Plugins, side-model calls, and local utility work use this lane so they stay useful even when cloud access is unavailable."}
				</p>
			</div>
			<AgentSelectionField
				allowedAgentIds={allowedAgentIds}
				allowedProviderIds={allowedProviderIds}
				ariaLabel={
					cloud ? "Choose default cloud agent" : "Choose default local agent"
				}
				disabled={busy}
				forceModelPicker
				onChange={onChange}
				preserveRyuRoute
				target={target}
				value={selection}
			/>
			{cloud ? null : (
				<p className="text-pretty text-detail text-muted-foreground">
					<span className="text-status-warning">Heads up:</span> local models
					can produce a weaker profile build. A stronger ACP agent or the Ryu
					cloud model does better.
				</p>
			)}
			{cloud && isEmpty ? (
				<p className="text-detail text-muted-foreground">
					No cloud default is configured yet. Chats will use your local default.
				</p>
			) : null}
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			<ContinueRow
				continueLabel={cloud && isEmpty ? "Use local for now" : "Save default"}
				onContinue={onContinue}
				onSkip={onSkip}
			/>
		</div>
	);
}

export function OrganizationPicker({
	organizations,
	selectedOrganizationId,
	onChoose,
	onContinue,
}: {
	onChoose: (id: string) => void;
	onContinue: () => void;
	organizations: OnboardingOrganization[];
	selectedOrganizationId: string | null;
}) {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-1">
				{organizations.map((organization) => {
					const selected = selectedOrganizationId === organization.id;
					return (
						<button
							aria-pressed={selected}
							className={cn(
								"flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-150 hover:duration-0",
								selected ? "bg-accent" : "hover:bg-muted"
							)}
							key={organization.id}
							onClick={() => onChoose(organization.id)}
							type="button"
						>
							{organization.logo ? (
								// org logos are user-provided
								<img
									alt=""
									className="size-8 rounded-lg object-cover"
									src={safeMediaUrl(organization.logo) ?? undefined}
								/>
							) : (
								<div className="flex size-8 items-center justify-center rounded-lg bg-muted font-medium text-sm">
									{organization.name.slice(0, 1).toUpperCase()}
								</div>
							)}
							<span className="min-w-0 flex-1">
								<span
									className="block truncate font-medium text-sm"
									title={organization.name}
								>
									{organization.name}
								</span>
								<span className="block truncate text-detail text-muted-foreground">
									{organization.isPersonal
										? "Personal workspace"
										: organization.slug}
								</span>
							</span>
							<span className="text-detail text-muted-foreground capitalize">
								{organization.role ?? "member"}
							</span>
						</button>
					);
				})}
			</div>
			<ContinueRow disabled={!selectedOrganizationId} onContinue={onContinue} />
		</div>
	);
}

export function ImportSetup({
	busy = false,
	autoImport,
	groups,
	importing,
	onImport,
	onSkip,
	onToggle,
}: {
	busy?: boolean;
	autoImport: boolean;
	groups: OnboardingThreadGroup[];
	importing: boolean;
	onImport: () => void;
	onSkip: () => void;
	onToggle: (enabled: boolean) => void;
}) {
	const tl = useLiteralMessages();
	const total = groups.reduce((sum, group) => sum + group.threads.length, 0);
	return (
		<div className="flex flex-col gap-6">
			{total > 0 ? (
				<div className="flex flex-col">
					{groups.map((group) => (
						<div
							className="flex h-12 items-center justify-between gap-6 border-border border-b"
							key={group.agentId}
						>
							<p className="font-medium text-sm">{group.agentName}</p>
							<p className="text-detail text-muted-foreground tabular-nums">
								{tl(
									"{count, plural, one {{countText} thread} other {{countText} threads}}",
									{
										count: group.threads.length,
										countText: String(group.threads.length),
									}
								)}
							</p>
						</div>
					))}
				</div>
			) : (
				<p className="text-center text-muted-foreground text-sm">
					No importable threads were found on this node.
				</p>
			)}
			<div className="flex items-center justify-between gap-6">
				<div>
					<p className="font-medium text-sm">Auto-import future threads</p>
					<p className="text-detail text-muted-foreground">
						Keep new agent sessions available in Ryu automatically.
					</p>
				</div>
				<Switch
					checked={autoImport}
					disabled={busy || importing}
					onCheckedChange={onToggle}
				/>
			</div>
			<ContinueRow
				continueLabel={
					importing ? "Importing…" : total > 0 ? "Import threads" : "Continue"
				}
				disabled={importing}
				onContinue={total > 0 ? onImport : onSkip}
				onSkip={onSkip}
			/>
		</div>
	);
}
