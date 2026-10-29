"use client";

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
} from "@ryu/ui/components/field";
import { GoogleBrandMark } from "@ryu/ui/components/google-brand-mark.tsx";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import PageHeader from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { Switch } from "@ryu/ui/components/switch";
import { Fingerprint, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import PasswordField from "./password-field.tsx";

export type SignInLastUsedMethod = string | null;

export interface SignInValues {
	email: string;
	password: string;
	rememberDevice: boolean;
}

export interface SignInFormProps {
	/** Captcha widget slot (the live app injects its Turnstile here). */
	captcha?: ReactNode;
	/** True while a passwordless device approval request is being created. */
	deviceApprovalLoading?: boolean;
	/** Field-level validation error message for email. */
	emailError?: string;
	/** Google sign-in request in flight. */
	googleLoading?: boolean;
	/** Which method the user last signed in with (drives the "Last used" badge). */
	lastUsedMethod?: SignInLastUsedMethod;
	/** Submit/credential request in flight. */
	loading?: boolean;
	/** Start a passwordless approval on another signed-in Ryu device. */
	onDeviceApproval?: (email: string) => void | Promise<void>;
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

const CALLBACK_PARAMS = ["callback", "callbackURL", "callbackUrl", "next"];

/**
 * Whether the sign-in was opened from a certification exam link. Read after
 * mount from the URL so the presentational block needs no router context.
 */
function useExamCallback(): boolean {
	const [isExam, setIsExam] = useState(false);
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const callback = CALLBACK_PARAMS.map((name) => params.get(name)).find(
			(value) => value !== null
		);
		setIsExam(callback?.startsWith("/certifications/") ?? false);
	}, []);
	return isExam;
}

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
	deviceApprovalLoading = false,
	lastUsedMethod = null,
	useMagicLink = false,
	onToggleMagicLink = noop,
	onGoogle = noop,
	onDeviceApproval,
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
	const examSignIn = useExamCallback();
	const submitting =
		loading ||
		sendingMagicLink ||
		passkeyLoading ||
		ssoLoading ||
		deviceApprovalLoading;

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
					subtitleClassName="font-normal text-sm"
					title={examSignIn ? "Sign in to take the exam" : "Sign in to Ryu"}
					titleClassName="text-2xl tracking-tight"
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
								className="h-16"
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
								variant="muted"
							/>
							{visibleEmailError ? (
								<FieldError
									errors={[{ message: visibleEmailError }]}
									id="email-error"
								/>
							) : null}
						</Field>

						{useMagicLink ? null : (
							<PasswordField
								autoComplete="current-password"
								error={visiblePasswordError}
								errorId="password-error"
								id="password"
								label="Password"
								name="password"
								onChange={(value) => {
									setPassword(value);
									setPasswordEdited(true);
								}}
								placeholder="Password"
								value={password}
							/>
						)}
					</FieldGroup>

					{captcha}

					<div className="mb-6 flex items-start gap-2">
						<Switch
							checked={rememberDevice}
							disabled={submitting}
							id="remember-device"
							onCheckedChange={setRememberDevice}
						/>
						<div className="grid gap-1">
							<Label htmlFor="remember-device" variant="choice">
								Remember this device for 30 days
							</Label>
							{useMagicLink ? (
								<p className="text-muted-foreground text-xs">
									Open the email link in this browser to remember it.
								</p>
							) : null}
						</div>
					</div>

					<div className="relative">
						<Button
							className="w-full"
							disabled={submitting}
							size="lg"
							type="submit"
							variant="mono"
						>
							{submitting
								? useMagicLink
									? "Sending…"
									: "Signing in…"
								: useMagicLink
									? "Send me a link"
									: "Sign in"}
						</Button>
						{lastUsedMethod === "email" && !useMagicLink ? (
							<Badge
								className="absolute -top-2 -right-2"
								size="compact"
								variant="secondary"
							>
								Last used
							</Badge>
						) : null}
						{lastUsedMethod === "magic-link" && useMagicLink ? (
							<Badge
								className="absolute -top-2 -right-2"
								size="compact"
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
							className="w-full"
							disabled={googleLoading}
							onClick={onGoogle}
							size="lg"
							spacing="comfortable"
							variant="secondary"
						>
							<GoogleBrandMark className="h-5 w-5" />
							{googleLoading ? "Signing in…" : "Continue with Google"}
						</Button>
						{lastUsedMethod === "google" ? (
							<Badge
								className="absolute -top-2 -right-2"
								size="compact"
								variant="secondary"
							>
								Last used
							</Badge>
						) : null}
					</div>

					<Accordion appearance="plain" defaultValue={[]}>
						<AccordionItem appearance="plain" value="more-options">
							<AccordionTrigger appearance="plain">
								More options
							</AccordionTrigger>
							<AccordionContent spacing="flush">
								<div className="flex flex-col gap-4">
									{onDeviceApproval ? (
										<Button
											className="w-full"
											disabled={submitting}
											onClick={() => onDeviceApproval(email)}
											size="lg"
											spacing="comfortable"
											type="button"
											variant="secondary"
										>
											<Smartphone className="h-5 w-5" />
											{deviceApprovalLoading
												? "Waiting for another device…"
												: "Approve on another device"}
										</Button>
									) : null}

									{onPasskey ? (
										<div className="relative">
											<Button
												className="w-full"
												disabled={submitting}
												onClick={() => onPasskey(rememberDevice)}
												size="lg"
												spacing="comfortable"
												variant="secondary"
											>
												<Fingerprint className="h-5 w-5" />
												{passkeyLoading ? "Checking passkey…" : "Use a passkey"}
											</Button>
											{lastUsedMethod === "passkey" ? (
												<Badge
													className="absolute -top-2 -right-2"
													size="compact"
													variant="secondary"
												>
													Last used
												</Badge>
											) : null}
										</div>
									) : null}

									{onSSO ? (
										<Button
											className="w-full"
											disabled={submitting}
											onClick={() => onSSO(email)}
											size="lg"
											spacing="comfortable"
											variant="secondary"
										>
											{ssoLoading
												? "Redirecting to your identity provider…"
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

					{/* Two quiet links, no "Or" divider: they are unrelated actions. */}
					<div className="flex flex-col items-center">
						{!useMagicLink && showForgotPassword ? (
							<Button
								onClick={onForgotPassword}
								size="sm"
								variant="ghost-muted"
							>
								Forgot your password?
							</Button>
						) : null}
						<Button onClick={onSwitchToSignUp} size="sm" variant="ghost-muted">
							Don&apos;t have an account? Create one
						</Button>
					</div>
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
