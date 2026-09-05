"use client";

import { ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import type { ReactNode, SVGProps } from "react";
import { useEffect, useState } from "react";
import { PasswordStrengthMeter } from "./password-strength.tsx";

/** Google brand mark, inlined so the block has no app-local SVG dependency. */
function Google(props: SVGProps<SVGSVGElement>) {
	return (
		<svg {...props} fill="none" viewBox="0 0 24 24">
			<title>Google</title>
			<path
				d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
				fill="#4285F4"
			/>
			<path
				d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
				fill="#34A853"
			/>
			<path
				d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
				fill="#FBBC05"
			/>
			<path
				d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
				fill="#EA4335"
			/>
		</svg>
	);
}

export interface SignUpValues {
	email: string;
	name: string;
	password: string;
}

export interface SignUpFormProps {
	/** Captcha widget slot (the live app injects its Turnstile here). */
	captcha?: ReactNode;
	emailError?: string;
	/** Google sign-up request in flight. */
	googleLoading?: boolean;
	/** Create-account request in flight. */
	loading?: boolean;
	/** Field-level validation error messages. */
	nameError?: string;
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
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
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
								className="h-16 border-0 bg-muted shadow-none"
								id="name"
								name="name"
								onChange={(e) => {
									setName(e.target.value);
									setEdited((s) => ({ ...s, name: true }));
								}}
								placeholder="Name"
								value={name}
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
								className="h-16 border-0 bg-muted shadow-none"
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
							/>
							{visibleEmailError ? (
								<FieldError
									errors={[{ message: visibleEmailError }]}
									id="email-error"
								/>
							) : null}
						</Field>

						<Field data-invalid={Boolean(visiblePasswordError)}>
							<FieldLabel className="sr-only" htmlFor="password">
								Password
							</FieldLabel>
							<div className="relative w-full">
								<Input
									aria-describedby={
										visiblePasswordError
											? "password-error password-strength-label password-strength-requirements"
											: "password-strength-label password-strength-requirements"
									}
									aria-invalid={Boolean(visiblePasswordError)}
									autoComplete="new-password"
									className="h-16 border-0 bg-muted pr-14 shadow-none"
									id="password"
									name="password"
									onChange={(e) => {
										setPassword(e.target.value);
										setEdited((s) => ({ ...s, password: true }));
									}}
									placeholder="Password"
									type={showPassword ? "text" : "password"}
									value={password}
								/>
								<Button
									aria-label={showPassword ? "Hide password" : "Show password"}
									aria-pressed={showPassword}
									className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground"
									onClick={() => setShowPassword((v) => !v)}
									size="icon-sm"
									type="button"
									variant="ghost"
								>
									<HugeiconsIcon
										icon={showPassword ? ViewOffSlashIcon : ViewIcon}
										strokeWidth={2}
									/>
								</Button>
							</div>
							<PasswordStrengthMeter
								className="px-1"
								idPrefix="password-strength"
								value={password}
							/>
							{visiblePasswordError ? (
								<FieldError
									errors={[{ message: visiblePasswordError }]}
									id="password-error"
								/>
							) : null}
						</Field>
					</FieldGroup>

					{captcha}

					<Button className="w-full" disabled={loading} size="lg" type="submit">
						{loading ? "Creating account..." : "Sign up"}
					</Button>
				</form>

				<div className="flex flex-col gap-4 text-center">
					<Button
						className="w-full gap-3"
						disabled={googleLoading}
						onClick={onGoogle}
						size="lg"
						variant="secondary"
					>
						<Google className="h-5 w-5" />
						{googleLoading ? "Creating account..." : "Sign up with Google"}
					</Button>

					<Button
						className="mx-auto text-muted-foreground"
						onClick={onSwitchToSignIn}
						variant="ghost"
					>
						Already have an account? Sign in
					</Button>
				</div>

				<div className="text-center text-muted-foreground text-sm">
					By creating an account, you agree to our{" "}
					<a className="underline" href="/terms">
						Terms
					</a>
					<br />
					and{" "}
					<a className="underline" href="/privacy">
						Privacy Policy
					</a>
				</div>
			</StaggerReveal>
		</div>
	);
}
