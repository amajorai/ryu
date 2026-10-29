import { Alert02Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type {
	AgentLifecycleStatus,
	AgentSafetyProfile,
} from "@/src/lib/api/agents.ts";

const LIFECYCLE_LABELS = {
	draft: "Draft",
	trial: "Trial",
	active: "Active",
} satisfies Record<AgentLifecycleStatus, string>;

const SAFETY_LABELS = {
	read_only: "Read-only",
	approval_required: "Approval required",
	verified_plan_only: "Verified plans only",
	autonomous: "Autonomous",
} satisfies Record<AgentSafetyProfile, string>;

export function AgentExecutionPolicyPanel({
	disabled,
	isNew,
	lifecycleStatus,
	onLifecycleStatusChange,
	onSafetyProfileChange,
	onPostureRetry,
	postureError,
	postureSaving,
	safetyProfile,
}: {
	disabled: boolean;
	isNew: boolean;
	lifecycleStatus: AgentLifecycleStatus;
	onLifecycleStatusChange: (status: AgentLifecycleStatus) => void;
	onSafetyProfileChange: (profile: AgentSafetyProfile) => void;
	onPostureRetry?: () => void;
	postureError?: string | null;
	postureSaving?: boolean;
	safetyProfile: AgentSafetyProfile;
}) {
	const tl = useLiteralMessages();
	const activeDisabled = isNew || lifecycleStatus === "draft";
	const warning =
		lifecycleStatus === "draft"
			? "Draft is authoring-only. It cannot chat, be selected, delegated to, or run automation."
			: lifecycleStatus === "trial"
				? "Trial is for manual evaluation. Reads and explicit previews are allowed; writes, unknown tools, memory writes, channels, delegation, and automations are blocked."
				: safetyProfile === "read_only"
					? "Read-only allows retrieval and previews only. Core blocks state changes even when a tool is not marked risky."
					: safetyProfile === "approval_required"
						? "Risky and unknown-effect tools enter the existing approval queue before they run."
						: safetyProfile === "verified_plan_only"
							? "Only deterministic plans verified and certified by Core may run tools. Direct tool calls are blocked."
							: null;

	return (
		<SettingsSection
			caption="Lifecycle controls availability; safety controls what an available agent may do. Core enforces both at dispatch time."
			headerAction={
				<Badge variant={lifecycleStatus === "active" ? "secondary" : "outline"}>
					{LIFECYCLE_LABELS[lifecycleStatus]}
				</Badge>
			}
			title="Lifecycle & safety"
		>
			<SettingsCard className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<label className="flex flex-col gap-1.5 text-sm">
						<span className="font-medium">Lifecycle</span>
						<NativeSelect
							aria-label="Agent lifecycle"
							disabled={disabled || postureSaving}
							onChange={(event) =>
								onLifecycleStatusChange(
									/* SAFETY: NativeSelect forwards this authored select event; its options are exactly draft, trial and active. This is a native UI selection, not a decoder for arbitrary synthetic events. */ event
										.target.value as AgentLifecycleStatus
								)
							}
							value={lifecycleStatus}
						>
							<NativeSelectOption value="draft">Draft</NativeSelectOption>
							<NativeSelectOption value="trial">Trial</NativeSelectOption>
							<NativeSelectOption disabled={activeDisabled} value="active">
								{isNew ? tl("Active (after Trial save)") : tl("Active")}
							</NativeSelectOption>
						</NativeSelect>
					</label>

					<label className="flex flex-col gap-1.5 text-sm">
						<span className="font-medium">Safety profile</span>
						<NativeSelect
							aria-label="Agent safety profile"
							disabled={disabled || postureSaving}
							onChange={(event) =>
								onSafetyProfileChange(
									/* SAFETY: This NativeSelect renders only SAFETY_LABELS keys, checked against AgentSafetyProfile by satisfies. This is a native UI selection, not a decoder for arbitrary synthetic events. */ event
										.target.value as AgentSafetyProfile
								)
							}
							value={safetyProfile}
						>
							{Object.entries(SAFETY_LABELS).map(([value, label]) => (
								<NativeSelectOption key={value} value={value}>
									{label}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</label>
				</div>

				{warning ? (
					<div className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
						<HugeiconsIcon
							className="mt-0.5 size-4 shrink-0 text-foreground"
							icon={lifecycleStatus === "active" ? Shield01Icon : Alert02Icon}
						/>
						<span>{warning}</span>
					</div>
				) : null}

				{lifecycleStatus === "trial" ? (
					<p className="text-muted-foreground text-xs">
						Effective safety: <strong>Read-only</strong>. The saved profile is
						preserved for when you promote the agent.
					</p>
				) : null}
				{postureError ? (
					<div className="flex items-center gap-2">
						<p className="text-status-destructive text-xs">{postureError}</p>
						{onPostureRetry ? (
							<Button
								disabled={postureSaving}
								onClick={onPostureRetry}
								type="button"
							>
								Retry
							</Button>
						) : null}
					</div>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
