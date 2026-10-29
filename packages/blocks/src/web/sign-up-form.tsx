"use client";

import {
	AGE_ELIGIBILITY_SECONDS,
	AgeEligibilityDeniedError,
	meetsMinimumAccountAge,
} from "@ryu/auth/lib/age-eligibility";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field";
import { GoogleBrandMark } from "@ryu/ui/components/google-brand-mark.tsx";
import { Input } from "@ryu/ui/components/input";
import PageHeader from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { docsHref } from "./data/resources.tsx";
import PasswordField from "./password-field.tsx";
import { PasswordStrengthMeter } from "./password-strength.tsx";

export interface SignUpValues {
	email: string;
	name: string;
	password: string;
}

export interface SignUpFormProps {
	ageCheckRequired?: boolean;
	/** Captcha widget slot (the live app injects its Turnstile here). */
	captcha?: ReactNode;
	emailError?: string;
	/** Google sign-up request in flight. */
	googleLoading?: boolean;
	/** Create-account request in flight. */
	loading?: boolean;
	/** Field-level validation error messages. */
	nameError?: string;
	/**
	 * Server age check. Called only after the visitor has ticked the Terms and
	 * Privacy checkbox, so the live handler sends `acceptedTerms: true`.
	 */
	onCheckAge?: (dateOfBirth: string) => Promise<void>;
	/** Sign-up-with-Google handler. */
	onGoogle?: () => void | Promise<void>;
	/** Called with the entered details when the form is submitted. */
	onSubmit?: (value: SignUpValues) => void | Promise<void>;
	/** Switch to the sign-in view. */
	onSwitchToSignIn?: () => void;
	passwordError?: string;
}

const noop = () => {
	// presentational default; the live app injects real handlers
};

/**
 * The real web sign-up form, presentational. The live login page passes
 * authClient-backed handlers and a Turnstile captcha node via props; the
 * storyboard renders it standalone with static state.
 */
export default function SignUpForm({
	ageCheckRequired = false,
	onCheckAge,
	onSubmit = noop,
	loading = false,
	googleLoading = false,
	onGoogle = noop,
	onSwitchToSignIn = noop,
	nameError,
	emailError,
	passwordError,
	captcha,
}: SignUpFormProps) {
	const [dateOfBirth, setDateOfBirth] = useState("");
	const [ageChecked, setAgeChecked] = useState(false);
	const [checkingAge, setCheckingAge] = useState(false);
	const [ageError, setAgeError] = useState<string>();
	const [ageDenied, setAgeDenied] = useState(false);
	const [acceptedTerms, setAcceptedTerms] = useState(false);
	const [termsError, setTermsError] = useState<string>();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	useEffect(() => {
		if (ageCheckRequired) {
			setAgeChecked(false);
			setAgeError("Please repeat the age check before creating your account.");
		}
	}, [ageCheckRequired]);
	useEffect(() => {
		if (!ageChecked) {
			return;
		}
		const timeout = setTimeout(() => {
			setAgeChecked(false);
			setAgeError("Your age check expired. Please check again.");
		}, AGE_ELIGIBILITY_SECONDS * 1000);
		return () => clearTimeout(timeout);
	}, [ageChecked]);
	// See sign-in-form.tsx: an edited field is back in its default state, so its
	// stale error is withheld until the next submit produces a fresh one.
	const [edited, setEdited] = useState({
		name: false,
		email: false,
		password: false,
	});
	useEffect(
		() => setEdited({ name: false, email: false, password: false }),
		[nameError, emailError, passwordError]
	);
	const visibleNameError = edited.name ? undefined : nameError;
	const visibleEmailError = edited.email ? undefined : emailError;
	const visiblePasswordError = edited.password ? undefined : passwordError;

	if (!ageChecked) {
		return (
			<div className="mx-auto flex w-full max-w-md flex-col gap-6">
				<PageHeader
					subtitle="Check your eligibility before entering your account details"
					title="Create an account"
				/>
				{ageDenied ? (
					<p role="alert">You are not eligible to create a Ryu account.</p>
				) : (
					<form
						className="space-y-4"
						onSubmit={async (event) => {
							event.preventDefault();
							if (!acceptedTerms) {
								setTermsError(
									"Agree to the Terms of Service and Privacy Policy to continue."
								);
								return;
							}
							setCheckingAge(true);
							setAgeError(undefined);
							try {
								if (onCheckAge) {
									await onCheckAge(dateOfBirth);
								} else if (!meetsMinimumAccountAge(dateOfBirth)) {
									setAgeDenied(true);
									return;
								}
								setDateOfBirth("");
								setAgeChecked(true);
							} catch (error) {
								if (error instanceof AgeEligibilityDeniedError) {
									setAgeDenied(true);
								} else {
									setAgeError(
										error instanceof Error
											? error.message
											: "Could not check eligibility. Try again."
									);
								}
							} finally {
								setCheckingAge(false);
							}
						}}
					>
						<FieldGroup>
							<Field data-invalid={Boolean(ageError)}>
								<FieldLabel htmlFor="date-of-birth">Date of birth</FieldLabel>
								<Input
									aria-describedby={
										ageError ? "age-privacy age-error" : "age-privacy"
									}
									aria-invalid={Boolean(ageError)}
									autoComplete="bday"
									className="h-16"
									id="date-of-birth"
									onChange={(event) => setDateOfBirth(event.target.value)}
									required
									type="date"
									value={dateOfBirth}
									variant="muted"
								/>
								{ageError ? (
									<FieldError errors={[{ message: ageError }]} id="age-error" />
								) : null}
							</Field>
						</FieldGroup>
						<p className="text-muted-foreground text-sm" id="age-privacy">
							We use your date of birth only to check eligibility. It is not
							saved to your account.
						</p>
						<Field data-invalid={Boolean(termsError)} orientation="horizontal">
							<Checkbox
								aria-describedby={termsError ? "terms-error" : undefined}
								aria-invalid={Boolean(termsError)}
								checked={acceptedTerms}
								id="accept-terms"
								name="acceptedTerms"
								onCheckedChange={(checked) => {
									setAcceptedTerms(checked === true);
									setTermsError(undefined);
								}}
								required
							/>
							<FieldLabel
								className="font-normal text-muted-foreground text-sm"
								htmlFor="accept-terms"
							>
								<span>
									I agree to the{" "}
									<a
										className="underline"
										href={docsHref("/docs/legal/terms")}
										rel="noopener"
										target="_blank"
									>
										Terms of Service
									</a>{" "}
									and{" "}
									<a
										className="underline"
										href={docsHref("/docs/legal/privacy")}
										rel="noopener"
										target="_blank"
									>
										Privacy Policy
									</a>
								</span>
							</FieldLabel>
						</Field>
						{termsError ? (
							<FieldError errors={[{ message: termsError }]} id="terms-error" />
						) : null}
						<Button
							className="w-full"
							disabled={checkingAge}
							size="lg"
							type="submit"
						>
							{checkingAge ? "Checking..." : "Continue"}
						</Button>
					</form>
				)}
				<Button
					className="mx-auto"
					onClick={onSwitchToSignIn}
					variant="ghost-muted"
				>
					Already have an account? Sign in
				</Button>
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6">
			{/* Single reveal for the column — see the note in sign-in-form.tsx. */}
			<StaggerReveal>
				<PageHeader
					stagger={false}
					subtitle="Create an account to get started"
					title="Welcome"
				/>

				<form
					className="space-y-4"
					// The live app runs its own field validation in `onSubmit` and
					// surfaces friendly inline messages via <FieldError>. Without
					// `noValidate`, the browser's native `type="email"` check fires
					// first and blocks submit with a transient native bubble, so
					// `onSubmit` never runs and no inline message ever renders.
					noValidate
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onSubmit({ name, email, password });
					}}
				>
					<FieldGroup>
						{/* Labels are visually hidden, not absent — the placeholder is the
						    visual treatment, but it is not an accessible name. */}
						<Field data-invalid={Boolean(visibleNameError)}>
							<FieldLabel className="sr-only" htmlFor="name">
								Full name
							</FieldLabel>
							<Input
								aria-describedby={visibleNameError ? "name-error" : undefined}
								aria-invalid={Boolean(visibleNameError)}
								autoComplete="name"
								className="h-16"
								id="name"
								name="name"
								onChange={(e) => {
									setName(e.target.value);
									setEdited((s) => ({ ...s, name: true }));
								}}
								placeholder="Name"
								value={name}
								variant="muted"
							/>
							{visibleNameError ? (
								<FieldError
									errors={[{ message: visibleNameError }]}
									id="name-error"
								/>
							) : null}
						</Field>

						<Field data-invalid={Boolean(visibleEmailError)}>
							<FieldLabel className="sr-only" htmlFor="email">
								Email address
							</FieldLabel>
							<Input
								aria-describedby={visibleEmailError ? "email-error" : undefined}
								aria-invalid={Boolean(visibleEmailError)}
								autoComplete="email"
								className="h-16"
								id="email"
								inputMode="email"
								name="email"
								onChange={(e) => {
									setEmail(e.target.value);
									setEdited((s) => ({ ...s, email: true }));
								}}
								placeholder="Email Address"
								type="email"
								value={email}
								variant="muted"
							/>
							{visibleEmailError ? (
								<FieldError
									errors={[{ message: visibleEmailError }]}
									id="email-error"
								/>
							) : null}
						</Field>

						<PasswordField
							autoComplete="new-password"
							descriptionIds="password-strength-label password-strength-requirements"
							error={visiblePasswordError}
							errorId="password-error"
							id="password"
							label="Password"
							name="password"
							onChange={(value) => {
								setPassword(value);
								setEdited((current) => ({ ...current, password: true }));
							}}
							placeholder="Password"
							value={password}
						>
							<PasswordStrengthMeter
								className="px-1"
								idPrefix="password-strength"
								value={password}
							/>
						</PasswordField>
					</FieldGroup>

					{captcha}

					<Button className="w-full" disabled={loading} size="lg" type="submit">
						{loading ? "Creating account…" : "Sign up"}
					</Button>
				</form>

				<div className="flex flex-col gap-4 text-center">
					<Button
						className="w-full"
						disabled={googleLoading}
						onClick={onGoogle}
						size="lg"
						spacing="comfortable"
						variant="secondary"
					>
						<GoogleBrandMark className="h-5 w-5" />
						{googleLoading ? "Creating account…" : "Sign up with Google"}
					</Button>

					<Button
						className="mx-auto"
						onClick={onSwitchToSignIn}
						variant="ghost-muted"
					>
						Already have an account? Sign in
					</Button>
				</div>

				<p className="text-center text-muted-foreground text-sm">
					You accepted our{" "}
					<a className="underline" href={docsHref("/docs/legal/terms")}>
						Terms
					</a>{" "}
					and{" "}
					<a className="underline" href={docsHref("/docs/legal/privacy")}>
						Privacy Policy
					</a>{" "}
					in the previous step.
				</p>
			</StaggerReveal>
		</div>
	);
}
