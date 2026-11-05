import { describe, expect, it } from "bun:test";
import type { TwoFactorActions } from "@ryu/settings/hooks/useTwoFactorDialog";
import {
	TwoFactorStepUpRequiredError,
	throwTwoFactorResultError,
	withTwoFactorStepUp,
} from "./two-factor-step-up.ts";

/** A server whose disable/regenerate calls refuse until one proof is spent. */
function gatedServer() {
	const state = { enabled: true, proofs: 0 };
	const consume = () => {
		if (state.proofs === 0) {
			throwTwoFactorResultError({
				code: "STEP_UP_REQUIRED",
				message: "Verify your identity to continue",
			});
		}
		state.proofs -= 1;
	};
	const actions: TwoFactorActions = {
		disable: async () => {
			consume();
			state.enabled = false;
		},
		enable: async () => ({ backupCodes: [], totpUri: "otpauth://" }),
		regenerateBackupCodes: async () => {
			consume();
			return ["AAAAA-BBBBB"];
		},
		verify: async () => undefined,
	};
	return { actions, state };
}

describe("throwTwoFactorResultError", () => {
	it("marks the step-up refusal and passes other errors through", () => {
		expect(() =>
			throwTwoFactorResultError({ code: "STEP_UP_REQUIRED", message: "x" })
		).toThrow(TwoFactorStepUpRequiredError);
		let caught: unknown = null;
		try {
			throwTwoFactorResultError({ code: "INVALID_PASSWORD", message: "Bad" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(caught).not.toBeInstanceOf(TwoFactorStepUpRequiredError);
		expect(caught).toMatchObject({ message: "Bad" });
	});
});

describe("withTwoFactorStepUp", () => {
	it("prompts for account.security and retries once the factor is proven", async () => {
		const server = gatedServer();
		const scopes: string[] = [];
		const actions = withTwoFactorStepUp(server.actions, async (scope) => {
			scopes.push(scope);
			server.state.proofs += 1;
			return true;
		});
		expect(await actions.regenerateBackupCodes("pw")).toEqual(["AAAAA-BBBBB"]);
		await actions.disable("pw");
		expect(server.state.enabled).toBe(false);
		expect(scopes).toEqual(["account.security", "account.security"]);
	});

	it("leaves the account unchanged when the prompt is dismissed", async () => {
		const server = gatedServer();
		const actions = withTwoFactorStepUp(server.actions, async () => false);
		await expect(actions.disable("pw")).rejects.toThrow(
			"Verify your identity to continue"
		);
		expect(server.state.enabled).toBe(true);
	});

	it("does not prompt for a failure that is not a step-up", async () => {
		const server = gatedServer();
		let prompted = false;
		const actions = withTwoFactorStepUp(
			{
				...server.actions,
				disable: async () => {
					throw new Error("Invalid password");
				},
			},
			async () => {
				prompted = true;
				return true;
			}
		);
		await expect(actions.disable("wrong")).rejects.toThrow("Invalid password");
		expect(prompted).toBe(false);
	});
});
