import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	fetchTeamsSeatStatus,
	OrganizationPlanId,
} from "@/src/lib/api/teams-billing.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import { poolBundleRule } from "./TeamsBillingTab-pricing.ts";

/** Member-seat allocation against the organization's billed capacity. */
export function TeamsBillingSeatsSection({
	currentSeats,
	includedCreditBundle,
	organizationPlanId,
	seatStatus,
}: {
	currentSeats: number;
	includedCreditBundle: number;
	organizationPlanId: OrganizationPlanId | null;
	seatStatus: Awaited<ReturnType<typeof fetchTeamsSeatStatus>> | null;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection title="Seats">
			<SettingsGroup>
				<SettingsItem
					actions={
						<span className="text-muted-foreground text-sm tabular-nums">
							{seatStatus?.allocatedSeats ?? 0} of{" "}
							{seatStatus?.includedSeats ?? "—"}
						</span>
					}
					description={tl(
						seatStatus?.bonusSeats
							? "{memberCount} active members and {pendingInvitations} pending invitations reserve seats. {allocated} allocated of {capacity} capacity ({currentSeats} billed + {bonusSeats} negotiated); the shared pool adds {bundle} for {rule}."
							: "{memberCount} active members and {pendingInvitations} pending invitations reserve seats. {allocated} allocated of {capacity} capacity ({currentSeats} billed); the shared pool adds {bundle} for {rule}.",
						{
							allocated: String(seatStatus?.allocatedSeats ?? 0),
							bonusSeats: String(seatStatus?.bonusSeats ?? 0),
							bundle: `$${includedCreditBundle}`,
							capacity: String(seatStatus?.includedSeats ?? "—"),
							currentSeats: String(currentSeats),
							memberCount: String(seatStatus?.memberCount ?? 0),
							pendingInvitations: String(seatStatus?.pendingInvitations ?? 0),
							rule: poolBundleRule(organizationPlanId, tl),
						}
					)}
					title="Member seats"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
