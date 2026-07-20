"use client";

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldSeparator,
} from "@ryu/ui/components/field";
import { Input } from "@ryu/ui/components/input";
import PageHeader from "@ryu/ui/components/page-header";
import type { ReactNode, SVGProps } from "react";
import { useState } from "react";

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

export type SignInLastUsedMethod = "email" | "magic-link" | "google" | null;

export interface SignInValues {
	email: string;
	password: string;
}

export interface SignInFormProps {
	/** Captcha widget slot (the live app injects its Turnstile here). */
	captcha?: ReactNode;
	/** Field-level validation error message for email. */
	emailError?: string;
	/** Google sign-in request in flight. */
	googleLoading?: boolean;
	/** Which method the user last signed in with (drives the "Last used" badge). */
	lastUsedMethod?: SignInLastUsedMethod;
	/** Submit/credential request in flight. */
	loading?: boolean;
	/** Switch to the forgot-password view. */
	onForgotPassword?: () => void;
	/** Continue-with-Google handler. */
	onGoogle?: () => void | Promise<void>;
	/** Called with the entered credentials when the form is submitted. */
	onSubmit?: (value: SignInValues) => void | Promise<void>;
	/** Switch to the sign-up view. */
	onSwitchToSignUp?: () => void;
	/** Toggle between password and magic-link mode. */
	onToggleMagicLink?: () => void;
	/** Field-level validation error message for password. */
	passwordError?: string;
	/** True when the magic-link request is in flight. */
	sendingMagicLink?: boolean;
	/** Show the "Forgot your password?" link (the live app sets this true). */
	showForgotPassword?: boolean;
	/** Render the magic-link variant (email only, "Send me a link"). */
	useMagicLink?: boolean;
}

const noop = () => {
	// presentational default; the live app injects real handlers
};

/**
 * The real web sign-in form, presentational. The live login page passes
 * authClient-backed handlers and a Turnstile captcha node via props; the
 * storyboard renders it standalone with static state.
 */
export default function SignInForm({
	onSubmit = noop,
	loading = false,
	sendingMagicLink = false,
	googleLoading = false,
	lastUsedMethod = null,
	useMagicLink = false,
	onToggleMagicLink = noop,
	onGoogle = noop,
	onSwitchToSignUp = noop,
	onForgotPassword = noop,
	showForgotPassword = false,
	emailError,
	passwordError,
	captcha,
}: SignInFormProps) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const submitting = loading || sendingMagicLink;

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6">
			<PageHeader
				subtitle={
					useMagicLink
						? "Enter your email to receive a sign in link"
						: "Please sign in to continue"
				}
				title="Welcome back"
			/>

			<div>
				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onSubmit({ email, password });
					}}
				>
					<FieldGroup>
						<Field data-invalid={Boolean(emailError)}>
							<Input
								aria-invalid={Boolean(emailError)}
								className="h-16 border-0 bg-muted shadow-none"
								id="email"
								name="email"
								onChange={(e) => setEmail(e.target.value)}
								placeholder="Email Address"
								type="email"
								value={email}
							/>
							{emailError ? (
								<FieldError errors={[{ message: emailError }]} />
							) : null}
						</Field>

						{useMagicLink ? null : (
							<Field data-invalid={Boolean(passwordError)}>
								<Input
									aria-invalid={Boolean(passwordError)}
									className="h-16 border-0 bg-muted shadow-none"
									id="password"
									name="password"
									onChange={(e) => setPassword(e.target.value)}
									placeholder="Password"
									type="password"
									value={password}
								/>
								{passwordError ? (
									<FieldError errors={[{ message: passwordError }]} />
								) : null}
							</Field>
						)}
					</FieldGroup>

					{captcha}

					<div className="relative">
						<Button
							className="w-full"
							disabled={submitting}
							size="lg"
							type="submit"
						>
							{submitting
								? useMagicLink
									? "Sending..."
									: "Signing in..."
								: useMagicLink
									? "Send me a link"
									: "Sign in"}
						</Button>
						{lastUsedMethod === "email" && !useMagicLink ? (
							<Badge
								className="absolute -top-2 -right-2 text-[10px]"
								variant="secondary"
							>
								Last used
							</Badge>
						) : null}
						{lastUsedMethod === "magic-link" && useMagicLink ? (
							<Badge
								className="absolute -top-2 -right-2 text-[10px]"
								variant="secondary"
							>
								Last used
							</Badge>
						) : null}
					</div>
				</form>

				<div className="mt-4 flex flex-col gap-4 text-center">
					<div className="relative">
						<Button
							className="w-full gap-3"
							disabled={googleLoading}
							onClick={onGoogle}
							size="lg"
							variant="secondary"
						>
							<Google className="h-5 w-5" />
							{googleLoading ? "Signing in..." : "Continue with Google"}
						</Button>
						{lastUsedMethod === "google" ? (
							<Badge
								className="absolute -top-2 -right-2 text-[10px]"
								variant="secondary"
							>
								Last used
							</Badge>
						) : null}
					</div>

					<Button onClick={onToggleMagicLink} size="lg" variant="secondary">
						{useMagicLink ? "Use password instead" : "Send me a link"}
					</Button>

					<Button
						className="mx-auto text-muted-foreground"
						onClick={onSwitchToSignUp}
						variant="ghost"
					>
						Don&apos;t have an account? Create one
					</Button>

					{!useMagicLink && showForgotPassword ? (
						<>
							<FieldSeparator className="*:data-[slot=field-separator-content]:bg-background">
								Or
							</FieldSeparator>
							<Button
								className="mx-auto text-muted-foreground"
								onClick={onForgotPassword}
								variant="ghost"
							>
								Forgot your password?
							</Button>
						</>
					) : null}
				</div>

				<div className="mt-4 text-center text-muted-foreground text-sm">
					By signing in, you agree to our{" "}
					<a className="underline" href="/terms">
						Terms
					</a>
					<br />
					and{" "}
					<a className="underline" href="/privacy">
						Privacy Policy
					</a>
				</div>
			</div>
		</div>
	);
}
