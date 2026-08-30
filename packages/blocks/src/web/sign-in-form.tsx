"use client";

import { ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@ryu/ui/components/accordion.tsx";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldSeparator,
} from "@ryu/ui/components/field";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import PageHeader from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { Switch } from "@ryu/ui/components/switch";
import { Fingerprint } from "lucide-react";
import type { ReactNode, SVGProps } from "react";
import { useEffect, useState } from "react";

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

export type SignInLastUsedMethod =
	| "email"
	| "magic-link"
	| "google"
	| "passkey"
	| null;

export interface SignInValues {
	email: string;
	password: string;
	rememberDevice: boolean;
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
	/** Sign in with the device's passkey or security key. */
	onPasskey?: (rememberDevice: boolean) => void | Promise<void>;
	/** Continue-with-enterprise-SSO handler. Receives the email field value. */
	onSSO?: (email: string) => void | Promise<void>;
	/** Called with the entered credentials when the form is submitted. */
	onSubmit?: (value: SignInValues) => void | Promise<void>;
	/** Switch to the sign-up view. */
	onSwitchToSignUp?: () => void;
	/** Toggle between password and magic-link mode. */
	onToggleMagicLink?: () => void;
	/** True when a passkey ceremony is in flight. */
	passkeyLoading?: boolean;
	/** Field-level validation error message for password. */
	passwordError?: string;
	/** True when the magic-link request is in flight. */
	sendingMagicLink?: boolean;
	/** Show the "Forgot your password?" link (the live app sets this true). */
	showForgotPassword?: boolean;
	/** Enterprise SSO sign-in request in flight. */
	ssoLoading?: boolean;
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
	ssoLoading = false,
	passkeyLoading = false,
	lastUsedMethod = null,
	useMagicLink = false,
	onToggleMagicLink = noop,
	onGoogle = noop,
	onSSO,
	onPasskey,
	onSwitchToSignUp = noop,
	onForgotPassword = noop,
	showForgotPassword = false,
	emailError,
	passwordError,
	captcha,
}: SignInFormProps) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [rememberDevice, setRememberDevice] = useState(false);
	// A field that has been edited since its error arrived is back in its
	// default state — the error described the *previous* value, and leaving it
	// lit while the user retypes reads as "still wrong". Reset on each new
	// error so a second failed submit re-surfaces it.
	const [emailEdited, setEmailEdited] = useState(false);
	const [passwordEdited, setPasswordEdited] = useState(false);
	useEffect(() => setEmailEdited(false), [emailError]);
	useEffect(() => setPasswordEdited(false), [passwordError]);
	const visibleEmailError = emailEdited ? undefined : emailError;
	const visiblePasswordError = passwordEdited ? undefined : passwordError;
	const submitting =
		loading || sendingMagicLink || passkeyLoading || ssoLoading;

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6">
			{/* One reveal for the whole column, so the heading, the fields and each
			    button below them settle in sequence off a single clock — hence
			    `stagger={false}` on the header, which would otherwise run its own
			    two-line cascade on a second, unsynchronised clock.

			    The form, the alternate sign-in buttons and the terms used to share a
			    bare grouping div; they are direct children here so each becomes its
			    own line of the cascade rather than revealing together as one block.
			    That also makes them children of this `gap-6` column, so the `mt-4`
			    the latter two carried is dropped — the gap owns that spacing now. */}
			<StaggerReveal>
				<PageHeader
					stagger={false}
					subtitle={
						useMagicLink
							? "Enter your email to receive a sign in link"
							: "Please sign in to continue"
					}
					title="Welcome back"
				/>

				<form
					className="space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onSubmit({ email, password, rememberDevice });
					}}
				>
					<FieldGroup>
						{/* The oversized fields carry their name in the placeholder by
						    design, so the label is visually hidden rather than dropped —
						    a placeholder is not an accessible name and disappears the
						    moment the user types. */}
						<Field data-invalid={Boolean(visibleEmailError)}>
							<FieldLabel className="sr-only" htmlFor="email">
								Email address
							</FieldLabel>
							<Input
								aria-describedby={visibleEmailError ? "email-error" : undefined}
								aria-invalid={Boolean(visibleEmailError)}
								autoComplete="username webauthn"
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

						{useMagicLink ? null : (
							<Field data-invalid={Boolean(visiblePasswordError)}>
								<FieldLabel className="sr-only" htmlFor="password">
									Password
								</FieldLabel>
								<div className="relative w-full">
									<Input
										aria-describedby={
											visiblePasswordError ? "password-error" : undefined
										}
										aria-invalid={Boolean(visiblePasswordError)}
										autoComplete="current-password"
										className="h-16 border-0 bg-muted pr-14 shadow-none"
										id="password"
										name="password"
										onChange={(e) => {
											setPassword(e.target.value);
											setPasswordEdited(true);
										}}
										placeholder="Password"
										type={showPassword ? "text" : "password"}
										value={password}
									/>
									<Button
										aria-label={
											showPassword ? "Hide password" : "Show password"
										}
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
								{visiblePasswordError ? (
									<FieldError
										errors={[{ message: visiblePasswordError }]}
										id="password-error"
									/>
								) : null}
							</Field>
						)}
					</FieldGroup>

					{captcha}

					{useMagicLink ? null : (
						<div className="mb-6 flex items-center gap-2">
							<Switch
								checked={rememberDevice}
								disabled={submitting}
								id="remember-device"
								onCheckedChange={setRememberDevice}
							/>
							<Label className="text-sm" htmlFor="remember-device">
								Remember this device for 30 days
							</Label>
						</div>
					)}

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

				<div className="flex flex-col gap-4 text-center">
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

					<Accordion
						className="overflow-visible rounded-none border-0 bg-transparent shadow-none"
						defaultValue={[]}
					>
						<AccordionItem
							className="border-0 bg-transparent data-open:bg-transparent"
							value="more-options"
						>
							<AccordionTrigger className="border-0 bg-transparent shadow-none hover:bg-transparent hover:shadow-none">
								More options
							</AccordionTrigger>
							<AccordionContent className="p-0" panelClassName="p-0">
								<div className="flex flex-col gap-4">
									{onPasskey ? (
										<div className="relative">
											<Button
												className="w-full gap-3"
												disabled={submitting}
												onClick={() => onPasskey(rememberDevice)}
												size="lg"
												variant="secondary"
											>
												<Fingerprint className="h-5 w-5" />
												{passkeyLoading
													? "Checking passkey..."
													: "Use a passkey"}
											</Button>
											{lastUsedMethod === "passkey" ? (
												<Badge
													className="absolute -top-2 -right-2 text-[10px]"
													variant="secondary"
												>
													Last used
												</Badge>
											) : null}
										</div>
									) : null}

									{onSSO ? (
										<Button
											className="w-full gap-3"
											disabled={submitting}
											onClick={() => onSSO(email)}
											size="lg"
											variant="secondary"
										>
											{ssoLoading
												? "Redirecting to your identity provider..."
												: "Continue with SSO"}
										</Button>
									) : null}

									<Button
										className="w-full"
										onClick={onToggleMagicLink}
										size="lg"
										variant="secondary"
									>
										{useMagicLink ? "Use password instead" : "Send me a link"}
									</Button>
								</div>
							</AccordionContent>
						</AccordionItem>
					</Accordion>

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

				<div className="text-center text-muted-foreground text-sm">
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
			</StaggerReveal>
		</div>
	);
}
