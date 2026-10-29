"use client";

import {
	isFreeTextCode,
	STEP_UP_CODE_LENGTH,
	STEP_UP_METHOD_LABEL,
	type StepUpMethod,
} from "@ryu/step-up";
import { Button } from "@ryu/ui/components/button";
import { Field, FieldError, FieldLabel } from "@ryu/ui/components/field";
import { Input } from "@ryu/ui/components/input";
import { OTPInput, type OTPStatus } from "@ryu/ui/components/motion/otp-input";
import type { SyntheticEvent } from "react";
import PasswordField from "./password-field.tsx";

/**
 * The step-up ("confirm it's you") code form, presentational.
 *
 * The compact step-up dialog and full-page account verification flow share
 * this code input, confirm button, and method switching.
 *
 * The live dialog owns the verify call, the method switching and the retry; this
 * renders state it is handed, so the storyboard can show every branch.
 */

/**
 * Codes we ask for: authenticator, emailed code, printed recovery code. Aliased
 * from `@ryu/step-up` so the wire contract, the slot widths and this component
 * cannot drift apart.
 */
export type StepUpMethodChoice = StepUpMethod;

export interface StepUpVerifyProps {
	/** The code the user has typed. */
	code?: string;
	/** Rejection message shown under the slots. */
	error?: string | null;
	/** Verification in flight. */
	isSubmitting?: boolean;
	/** Which factor is being entered. */
	method?: StepUpMethodChoice;
	/** Render alternate methods like the full-width buttons on auth pages. */
	methodSwitchStyle?: "inline" | "stacked";
	/** Code change handler. */
	onCodeChange?: (value: string) => void;
	/** Fires once every slot is filled. */
	onCodeComplete?: (value: string) => void;
	/** Fires when one of `otherMethods` is picked. */
	onMethodChange?: (method: StepUpMethodChoice) => void;
	/** Re-send the emailed code. Omit when email is not on offer. */
	onResend?: () => void;
	/** Form submit handler. */
	onSubmit?: (event: SyntheticEvent<HTMLFormElement>) => void;
	/** Other factors on offer, rendered under the confirm button. */
	otherMethods?: StepUpMethodChoice[];
	/** True once the code cleared, so the slots can draw their check. */
	status?: OTPStatus;
}

const noop = () => {
	// presentational default; the live prompt injects real handlers
};

export default function StepUpVerify({
	code = "",
	error = null,
	isSubmitting = false,
	method = "totp",
	methodSwitchStyle = "inline",
	onCodeChange = noop,
	onCodeComplete = noop,
	onMethodChange = noop,
	onResend,
	onSubmit = noop,
	otherMethods = [],
	status = "idle",
}: StepUpVerifyProps) {
	const length = STEP_UP_CODE_LENGTH[method];
	const freeText = isFreeTextCode(method);
	const password = method === "password";
	const stackedMethods = methodSwitchStyle === "stacked";
	// A slot grid is only submittable when every slot is filled; a free-text
	// backup code just has to be non-empty, since its printed form varies.
	const ready = freeText ? code.trim().length > 0 : code.length >= length;
	return (
		// The page or dialog header carries the instruction so it is not repeated
		// between the heading and the code input.
		<form className="space-y-4" onSubmit={onSubmit}>
			{password ? (
				<PasswordField
					autoComplete="current-password"
					autoFocus
					disabled={isSubmitting}
					error={error ?? undefined}
					errorId="step-up-password-error"
					id="step-up-current-password"
					label="Current password"
					name="current-password"
					onChange={onCodeChange}
					placeholder="Current password"
					value={code}
				/>
			) : freeText ? (
				// A backup code is mixed-case and hyphenated (`xxxxx-xxxxx`), and the
				// slot grid normalizes to upper-case alphanumerics — it would quietly
				// mangle every one of them. Same reason the sign-in 2FA page keeps
				// backup codes on a plain field.
				<Field data-invalid={Boolean(error)}>
					<FieldLabel className="sr-only" htmlFor="step-up-backup-code">
						Backup code
					</FieldLabel>
					<Input
						aria-describedby={error ? "step-up-backup-code-error" : undefined}
						aria-invalid={Boolean(error)}
						autoComplete="off"
						autoFocus
						className="h-16 text-center"
						disabled={isSubmitting}
						id="step-up-backup-code"
						maxLength={length}
						name="backup-code"
						onChange={(event) => onCodeChange(event.target.value)}
						placeholder="xxxxx-xxxxx"
						spellCheck={false}
						type="text"
						value={code}
						variant="verification-code"
					/>
					{error ? (
						<FieldError
							errors={[{ message: error }]}
							id="step-up-backup-code-error"
						/>
					) : null}
				</Field>
			) : (
				<div className="flex justify-center">
					<OTPInput
						aria-label="Confirmation code"
						autoFocus
						disabled={isSubmitting}
						errorMessage={error ?? undefined}
						// Remounts on a method switch so the slot count changes cleanly
						// instead of half-applying.
						key={method}
						length={length}
						onChange={onCodeChange}
						onComplete={onCodeComplete}
						status={error ? "error" : status}
						successMessage="Verified."
						value={code}
					/>
				</div>
			)}
			<Button
				className="w-full"
				disabled={isSubmitting || !ready}
				size="lg"
				type="submit"
			>
				{isSubmitting ? "Verifying…" : "Confirm"}
			</Button>

			{(otherMethods.length > 0 || onResend) && (
				<div
					className={
						stackedMethods
							? "flex flex-col gap-4"
							: "flex flex-wrap justify-center gap-x-4 gap-y-1"
					}
				>
					{method === "otp" && onResend ? (
						<Button
							className={stackedMethods ? "w-full" : undefined}
							disabled={isSubmitting}
							onClick={onResend}
							size={stackedMethods ? "lg" : "sm"}
							type="button"
							variant={stackedMethods ? "secondary" : "ghost"}
						>
							Send it again
						</Button>
					) : null}
					{otherMethods.map((other) => (
						<Button
							className={stackedMethods ? "w-full" : undefined}
							disabled={isSubmitting}
							key={other}
							onClick={() => onMethodChange(other)}
							size={stackedMethods ? "lg" : "sm"}
							type="button"
							variant={stackedMethods ? "secondary" : "ghost"}
						>
							{STEP_UP_METHOD_LABEL[other]}
						</Button>
					))}
				</div>
			)}
		</form>
	);
}
