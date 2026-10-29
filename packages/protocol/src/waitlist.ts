import { z } from "zod";

export type WaitlistStatus = "pending" | "approved";

export type WaitlistApplicationStatus = "submitted" | "approved" | "rejected";

export interface WaitlistMe {
	applicationStatus: WaitlistApplicationStatus | null;
	displayUsername: string | null;
	eta: string | null;
	hasApplied: boolean;
	isAdmin: boolean;
	joinedAt: string | null;
	position: number | null;
	referralCode: string | null;
	referralCount: number;
	referralUrl: string | null;
	status: WaitlistStatus;
	totalWaiting: number;
	username: string | null;
}

export interface WaitlistStatusEvent {
	status: "approved";
}

/** The cloud approval stream emits this complete event contract. */
export const waitlistStatusEventSchema = z.looseObject({
	status: z.literal("approved"),
});
