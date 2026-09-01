/** Pure seat-admission rules shared by the Better Auth hooks and their tests. */

export interface SeatAdmissionDecision {
	readonly allowed: boolean;
	readonly reason?: string;
}

export interface OrganizationSeatUsage {
	readonly allocatedSeats: number;
	readonly atCapacity: boolean;
	readonly availableSeats: number | null;
	readonly memberCount: number;
	readonly overAllocated: boolean;
	readonly reservedSeatCount: number;
}

/**
 * Build the shared roster/billing view from authoritative counts. A pending
 * invitation is an allocation, while an organization without an active plan
 * has no usable invitation capacity.
 */
export const organizationSeatUsage = (input: {
	includedSeats: number | null;
	memberCount: number;
	reservedSeatCount: number;
}): OrganizationSeatUsage => {
	const memberCount = Math.max(0, Math.floor(input.memberCount));
	const reservedSeatCount = Math.max(0, Math.floor(input.reservedSeatCount));
	const allocatedSeats = memberCount + reservedSeatCount;
	const availableSeats =
		input.includedSeats === null
			? null
			: Math.max(input.includedSeats - allocatedSeats, 0);
	return {
		allocatedSeats,
		atCapacity:
			input.includedSeats !== null && allocatedSeats >= input.includedSeats,
		availableSeats,
		memberCount,
		overAllocated:
			input.includedSeats !== null && memberCount > input.includedSeats,
		reservedSeatCount,
	};
};

/**
 * A pending invitation and an in-flight membership claim both occupy a seat.
 * This function is intentionally pure so the database and Polar lookups remain
 * outside the policy itself.
 */
export const decideSeatAdmission = (input: {
	billedSeats: number;
	memberCount: number;
	reservedSeatCount: number;
}): SeatAdmissionDecision => {
	const seats = Math.max(0, Math.floor(input.billedSeats));
	const members = Math.max(0, Math.floor(input.memberCount));
	const reserved = Math.max(0, Math.floor(input.reservedSeatCount));
	if (members + reserved >= seats) {
		return {
			allowed: false,
			reason:
				"No unassigned organization seat is available. Buy another seat or remove a member first.",
		};
	}
	return { allowed: true };
};
