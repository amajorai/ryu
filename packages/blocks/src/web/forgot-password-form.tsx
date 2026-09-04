"use client";

import { Button } from "@ryu/ui/components/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field";
import { Input } from "@ryu/ui/components/input";
import PageHeader from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

export interface ForgotPasswordFormProps {
	/** Captcha widget slot (the live app injects its Turnstile here). */
	captcha?: ReactNode;
	/** Field-level validation error message for email. */
	emailError?: string;
	/** Reset-code request in flight. */
	loading?: boolean;
	/** Return to the sign-in view. */
	onBackToSignIn?: () => void;
	/** Called with the entered email when the form is submitted. */
	onSubmit?: (email: string) => void | Promise<void>;
}

const noop = () => {
	// presentational default; the live app injects real handlers
};

/**
 * The real web forgot-password form, presentational. The live login page
 * passes an authClient-backed handler via props; the storyboard renders it
 * standalone with static state.
 */
export default function ForgotPasswordForm({
	onSubmit = noop,
	loading = false,
	onBackToSignIn = noop,
	emailError,
	captcha,
}: ForgotPasswordFormProps) {
	const [email, setEmail] = useState("");
	// See sign-in-form.tsx: withhold a stale error once the field is edited.
	const [emailEdited, setEmailEdited] = useState(false);
	useEffect(() => setEmailEdited(false), [emailError]);
	const visibleEmailError = emailEdited ? undefined : emailError;

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6">
			{/* Single reveal for the column — see the note in sign-in-form.tsx: one
			    clock for heading + form + footer button, so `stagger={false}` keeps
			    the header from running its own. The form and the back-link block are
			    direct children so each is its own line, which also moves their
			    spacing onto this column's `gap-6`. */}
			<StaggerReveal>
				<PageHeader
					stagger={false}
					subtitle="We'll send you a code to reset your password"
					title="Forgot password"
				/>

				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onSubmit(email);
					}}
				>
					<FieldGroup>
						<Field data-invalid={Boolean(visibleEmailError)}>
							<FieldLabel className="sr-only" htmlFor="email">
								Email address
							</FieldLabel>
							<Input
								aria-describedby={visibleEmailError ? "email-error" : undefined}
								aria-invalid={Boolean(visibleEmailError)}
								autoComplete="email"
								autoFocus
								className="h-16 border-0 bg-muted shadow-none"
								id="email"
								inputMode="email"
								name="email"
								onChange={(e) => {
									setEmail(e.target.value);
									setEmailEdited(true);
								}}
								placeholder="Email Address"
								type="email"
								value={email}
							/>
							{visibleEmailError ? (
								<FieldError
									errors={[{ message: visibleEmailError }]}
									id="email-error"
								/>
							) : null}
						</Field>
					</FieldGroup>

					{captcha}

					<Button className="w-full" disabled={loading} size="lg" type="submit">
						{loading ? "Sending..." : "Send reset code"}
					</Button>
				</form>

				<div className="flex flex-col gap-4 text-center">
					<Button
						className="mx-auto text-muted-foreground"
						onClick={onBackToSignIn}
						variant="ghost"
					>
						Back to sign in
					</Button>
				</div>
			</StaggerReveal>
		</div>
	);
}
