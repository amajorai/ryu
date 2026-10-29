/** The account UI tests exercise authenticated settings mutations with a valid
 * step-up window; challenge enrollment and verification belong to auth tests. */
import type { StepUpClient } from "@ryu/step-up";

export const stepUpClient: StepUpClient = {
	challenge: async () => undefined,
	status: async (scope) => ({
		action: "change account security settings",
		enrolmentRequired: false,
		methods: ["password"],
		satisfied: true,
		scope,
		twoFactorEnabled: false,
		windowMs: 300_000,
	}),
	verify: async () => undefined,
	verifyMagicLink: async () => undefined,
};
