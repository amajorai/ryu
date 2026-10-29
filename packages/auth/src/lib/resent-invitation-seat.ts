import { z } from "zod";
import { organizationMutationSucceeded } from "./organization-mutation-result.ts";

export interface ResentInvitationSeat {
	expiresAt: Date;
	invitationId: string;
	organizationId: string;
}

/**
 * Native invite-member middleware authorizes a successful invitation result.
 * Better Auth does not retain its endpoint session on the global after-hook.
 */
const resentSeatSchema = z.object({
	id: z.string().refine((value) => value.trim().length > 0),
	organizationId: z.string().refine((value) => value.trim().length > 0),
	status: z.literal("pending"),
	expiresAt: z
		.union([
			z.date(),
			z
				.string()
				.transform((value) => new Date(value))
				.pipe(z.date()),
		])
		.refine((value) => value.getTime() > Date.now()),
});
export function successfulResentInvitationSeat(input: {
	returned: unknown;
	resend: unknown;
}): ResentInvitationSeat | null {
	if (input.resend !== true || !organizationMutationSucceeded(input.returned)) {
		return null;
	}
	const parsed = resentSeatSchema.safeParse(input.returned);
	if (!parsed.success) {
		return null;
	}
	return {
		invitationId: parsed.data.id,
		organizationId: parsed.data.organizationId,
		expiresAt: parsed.data.expiresAt,
	};
}
