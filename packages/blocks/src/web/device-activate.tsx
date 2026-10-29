"use client";

import { Button } from "@ryu/ui/components/button";
import { OTPInput } from "@ryu/ui/components/motion/otp-input";
import PageHeader from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import type { ReactNode, SubmitEvent } from "react";

/** Better Auth's current device-authorization default is eight characters. */
export const DEVICE_CODE_LENGTH = 8;

export interface DeviceActivateProps {
	/** Optional account switcher shown above the code form (device flow). */
	accountSwitcher?: ReactNode;
	/** Validation/verification error message. */
	error?: string | null;
	/** Verification request in flight. */
	isSubmitting?: boolean;
	/** Number of code slots. Defaults to Better Auth's current eight-character code. */
	length?: number;
	/** Fires once every slot is filled — the live route uses it to auto-submit. */
	onCodeComplete?: (value: string) => void;
	/** Form submit handler. */
	onSubmit?: (e: SubmitEvent<HTMLFormElement>) => void;
	/** Code input change handler — receives the ungrouped code. */
	onUserCodeChange?: (value: string) => void;
	/** The current device code value. */
	userCode?: string;
}

const noop = () => {
	// presentational default; the live app injects real handlers
};

/**
 * The real device-activation page, presentational. The live route owns the
 * authClient verify call, router redirect and session gating; the storyboard
 * renders it standalone with static state.
 */
export default function DeviceActivate({
	userCode = "",
	error = null,
	isSubmitting = false,
	length = DEVICE_CODE_LENGTH,
	onUserCodeChange = noop,
	onCodeComplete = noop,
	onSubmit = noop,
	accountSwitcher = null,
}: DeviceActivateProps) {
	const groupSize = length >= 6 && length % 2 === 0 ? length / 2 : undefined;

	return (
		<div className="flex min-h-[calc(100vh-5rem)] items-center justify-center px-4">
			<div className="w-full max-w-md space-y-8">
				{/* One clock for heading, account switcher and code form — see the
				    note in sign-in-form.tsx. `space-y-8` survives because
				    StaggerReveal renders its children in place with no wrapper. */}
				<StaggerReveal>
					<PageHeader
						stagger={false}
						subtitle="Enter the code displayed on your device to sign in"
						title="Activate device"
					/>

					{accountSwitcher}

					<form className="space-y-6" onSubmit={onSubmit}>
						<div className="flex justify-center">
							<OTPInput
								aria-label="Device activation code"
								autoFocus
								charset="alphanumeric"
								disabled={isSubmitting}
								errorMessage={error ?? undefined}
								groupSize={groupSize}
								length={length}
								onChange={onUserCodeChange}
								onComplete={onCodeComplete}
								status={error ? "error" : "idle"}
								value={userCode}
							/>
						</div>
						<Button
							className="w-full"
							disabled={isSubmitting || userCode.length < length}
							size="lg"
							type="submit"
							variant="mono"
						>
							{isSubmitting ? "Verifying…" : "Continue"}
						</Button>
					</form>
				</StaggerReveal>
			</div>
		</div>
	);
}
