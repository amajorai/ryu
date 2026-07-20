"use client";

import { Button } from "@ryu/ui/components/button";
import { Field, FieldError, FieldGroup } from "@ryu/ui/components/field";
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

	return (
		<div className="mx-auto flex w-full max-w-md flex-col gap-6">
			<PageHeader subtitle="Create an account to get started" title="Welcome" />

			<div>
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
						<Field data-invalid={Boolean(nameError)}>
							<Input
								aria-invalid={Boolean(nameError)}
								className="h-16 border-0 bg-muted shadow-none"
								id="name"
								name="name"
								onChange={(e) => setName(e.target.value)}
								placeholder="Name"
								value={name}
							/>
							{nameError ? (
								<FieldError errors={[{ message: nameError }]} />
							) : null}
						</Field>

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
					</FieldGroup>

					{captcha}

					<Button className="w-full" disabled={loading} size="lg" type="submit">
						{loading ? "Creating account..." : "Sign up"}
					</Button>
				</form>

				<div className="mt-4 flex flex-col gap-4 text-center">
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

				<div className="mt-4 text-center text-muted-foreground text-sm">
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
			</div>
		</div>
	);
}
