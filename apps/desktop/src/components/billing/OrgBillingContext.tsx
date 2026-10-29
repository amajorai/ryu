import { PlanBadge, type PlanTier } from "@ryu/ui/components/plan-badge.tsx";
import {
	SettingsGroup,
	SettingsItem,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useOrgBillingStatus } from "@/src/hooks/useOrgBillingStatus.ts";

export interface OrgBillingContextViewProps {
	compact?: boolean;
	description?: string;
	label?: string;
	organizationName: string | null;
	plan: PlanTier | null;
}

/**
 * Presentational form used by the live app and the end-to-end proof artifact.
 *
 * One grouped settings row — the label on the left, the organization and its
 * plan as the row's value — with the description as the card's footer caption.
 * Not a bordered or tinted banner: inside a settings pane that read as a box
 * above the cards instead of one of them.
 */
export function OrgBillingContextView({
	compact = false,
	description = "Managed inference uses this organization’s shared credit wallet.",
	label = "Billing organization",
	organizationName,
	plan,
}: OrgBillingContextViewProps) {
	return (
		<div data-testid="org-billing-context">
			<SettingsGroup>
				<SettingsItem
					actions={
						<span className="flex min-w-0 items-center gap-2">
							<span
								className="max-w-[16rem] truncate text-muted-foreground text-sm"
								title={organizationName ?? "No organization selected"}
							>
								{organizationName ?? "No organization selected"}
							</span>
							<PlanBadge
								className="shrink-0"
								plan={plan}
								size={compact ? "sm" : "md"}
							/>
						</span>
					}
					description={description || undefined}
					title={label}
				/>
			</SettingsGroup>
		</div>
	);
}

/** Live org-scoped context for desktop surfaces. */
export function OrgBillingContext(
	props: Omit<OrgBillingContextViewProps, "organizationName" | "plan"> & {
		organizationName?: string | null;
		plan?: PlanTier | null;
	}
) {
	const { organization, plan } = useOrgBillingStatus();
	return (
		<OrgBillingContextView
			{...props}
			organizationName={props.organizationName ?? organization?.name ?? null}
			plan={props.plan ?? plan}
		/>
	);
}
