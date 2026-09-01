export interface TeamsSeatStatus {
	allocatedSeats: number;
	availableSeats: number | null;
	billedSeats: number | null;
	bonusExpiresAt: string | null;
	bonusSeats: number;
	businessEmailBlockedMemberCount: number;
	businessEmailReason: string | null;
	businessEmailRequired: boolean;
	canInvite: boolean;
	canUpgradeToTeams: boolean;
	includedCreditPoolMicroUsd: number | null;
	includedSeats: number | null;
	invitationBlockedReason: string | null;
	memberCount: number;
	minRequired: number;
	minSeats: number;
	organizationId: string;
	organizationKind: "personal" | "teams";
	overAllocated: boolean;
	pendingInvitations: number;
	pendingSeatReservations: number;
	plan: string | null;
	teamEmailPolicyPassed: boolean;
}

export async function fetchTeamsSeatStatus(): Promise<TeamsSeatStatus> {
	return {
		allocatedSeats: 5,
		availableSeats: 0,
		billedSeats: 5,
		bonusExpiresAt: null,
		bonusSeats: 0,
		businessEmailBlockedMemberCount: 0,
		businessEmailReason: null,
		businessEmailRequired: false,
		canInvite: false,
		canUpgradeToTeams: false,
		includedCreditPoolMicroUsd: 50_000_000,
		includedSeats: 5,
		invitationBlockedReason:
			"All 5 organization seats are allocated. Buy more seats, remove a member, or cancel a pending invitation first.",
		memberCount: 4,
		minRequired: 5,
		minSeats: 5,
		organizationId: "org-northstar",
		organizationKind: "teams",
		overAllocated: false,
		pendingInvitations: 1,
		pendingSeatReservations: 1,
		plan: "teams",
		teamEmailPolicyPassed: true,
	};
}
