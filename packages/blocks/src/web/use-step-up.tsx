"use client";

import {
	isStepUpBlocking,
	isStepUpRequired,
	STEP_UP_METHOD_LABEL,
	type StepUpClient,
	type StepUpMethod,
	StepUpRequestError,
	type StepUpScope,
	stepUpPromptLine,
} from "@ryu/step-up";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import StepUpPage, { type StepUpPagePending } from "./step-up-page.tsx";
import StepUpVerify from "./step-up-verify.tsx";

/**
 * "Confirm it's you" — the prompt that stands between a signed-in session and
 * an action with no undo.
 *
 * Deliberately PRE-flight rather than a retry after a 403: the code is asked for
 * before the delete fires, so a person who cannot produce it has not started
 * anything. The reactive path still exists (the window can lapse between the
 * check and the request), which is what `isStepUpRequired` is for.
 *
 * The body is the shared `StepUpVerify` block — the same slot row, prompt line
 * and full-width button as the device-activation page, so a code entered here
 * reads as the one thing it is rather than as a new screen each time.
 */

interface Pending extends StepUpPagePending {
	resolve: (verified: boolean) => void;
}

export interface UseStepUpOptions {
	/** The surface's bound client — website cookie, desktop/mobile bearer token. */
	client: StepUpClient;
	/**
	 * Send the user to enrol a second factor. Staff scopes take no emailed
	 * fallback, so this is the only way out of that branch — and every surface
	 * routes differently (Next router, in-app route, deep link).
	 */
	onEnrol2fa: () => void;
	/** Optional host auth-page chrome for full-screen step-up pages. */
	pageHeader?: ReactNode;
	/** Scopes that should use a dedicated full-screen verification surface. */
	pageScopes?: readonly StepUpScope[];
}

export function useStepUp({
	client,
	onEnrol2fa,
	pageScopes = [],
	pageHeader,
}: UseStepUpOptions) {
	const [pending, setPending] = useState<Pending | null>(null);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	// Guards the auto-submit against firing twice for one complete code, the same
	// way the sign-in 2FA page does.
	const submittedRef = useRef<string | null>(null);

	const close = useCallback((verified: boolean) => {
		setPending((current) => {
			current?.resolve(verified);
			return null;
		});
		setCode("");
		setError(null);
		setIsSubmitting(false);
		submittedRef.current = null;
	}, []);

	/**
	 * Open the prompt and resolve once the user has proven a factor (or given
	 * up). Resolves `true` immediately when a live window already covers the
	 * scope, so a run of admin actions costs one code, not one per click.
	 */
	const prompt = useCallback(
		async (scope: StepUpScope): Promise<boolean> => {
			const status = await client.status(scope);
			if (status.satisfied) {
				return true;
			}
			const methods = status.methods;
			const first = methods[0] ?? "otp";
			let initialError: string | null = null;
			// The emailed code has to be requested before it can be typed; the other
			// two are already in the user's hand. A mailbox link is also issued here
			// so the dialog can start polling as soon as it opens.
			if (
				(first === "otp" || first === "magic-link") &&
				!status.enrolmentRequired
			) {
				await client.challenge(scope, first).catch((challengeError) => {
					initialError =
						challengeError instanceof Error
							? challengeError.message
							: "We couldn't send the verification email. Try again.";
				});
			}
			return await new Promise<boolean>((resolve) => {
				setCode("");
				setError(initialError);
				submittedRef.current = null;
				setPending({
					action: status.action,
					enrolmentRequired: status.enrolmentRequired,
					method: first,
					methods,
					resolve,
					scope,
				});
			});
		},
		[client]
	);

	/**
	 * Run `action` behind the prompt, and retry it once if the server asks for a
	 * step-up anyway (the window lapsed in between). Returns `null` when the user
	 * dismissed the prompt — nothing ran, so there is no result to report.
	 */
	const guard = useCallback(
		async <T,>(
			scope: StepUpScope,
			action: () => Promise<T>
		): Promise<T | null> => {
			if (!(await prompt(scope))) {
				return null;
			}
			try {
				const result = await action();
				if (!isStepUpRequired(result)) {
					return result;
				}
			} catch (err) {
				// Account-security authorization is one-use. Once its gate consumes
				// the proof, a follow-up status check cannot distinguish a valid
				// business error from a missing grant, so let the caller surface the
				// original error instead of prompting and replaying the mutation.
				if (scope === "account.security") {
					throw err;
				}
				// A thrown failure MIGHT be the gate: the fetch clients surface only
				// the server's human message, which carries no marker. Rather than
				// pattern-match a sentence, ask whether the window is still open — if
				// it is, this failure was something else and belongs to the caller.
				const stillOpen = await client
					.status(scope)
					.then((s) => s.satisfied)
					.catch(() => true);
				if (stillOpen) {
					throw err;
				}
			}
			if (!(await prompt(scope))) {
				return null;
			}
			return await action();
		},
		[client, prompt]
	);

	const submit = useCallback(
		async (value: string) => {
			if (!pending) {
				return;
			}
			const submitted = pending.method === "password" ? value : value.trim();
			if (!submitted || submittedRef.current === submitted) {
				return;
			}
			submittedRef.current = submitted;
			setIsSubmitting(true);
			setError(null);
			try {
				await client.verify({
					code: submitted,
					method: pending.method,
					scope: pending.scope,
				});
				close(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : "That code didn't work.");
				setIsSubmitting(false);
				// The slots are full, so nothing more can be typed — empty them so the
				// next attempt can auto-submit too.
				setCode("");
				submittedRef.current = null;
			}
		},
		[client, close, pending]
	);

	const switchMethod = useCallback(
		async (method: StepUpMethod) => {
			if (!pending) {
				return;
			}
			setPending({ ...pending, method });
			setCode("");
			setError(null);
			submittedRef.current = null;
			if (method === "otp" || method === "magic-link") {
				await client
					.challenge(pending.scope, method)
					.catch((challengeError: unknown) => {
						// A send inside the one-minute email cooldown is a wait, not a
						// failure, and the server's message says how long. Anything else
						// keeps the generic line rather than a server's wording.
						setError(
							challengeError instanceof StepUpRequestError &&
								challengeError.status === 429
								? challengeError.message
								: "We couldn't send the code. Try again."
						);
					});
			}
		},
		[client, pending]
	);

	useEffect(() => {
		if (pending?.method !== "magic-link") {
			return;
		}

		let stopped = false;
		const poll = async () => {
			try {
				const status = await client.status(pending.scope);
				if (!stopped && status.satisfied) {
					close(true);
				}
			} catch {
				// The original dialog remains useful if the browser briefly loses
				// connectivity while the mailbox page is open.
			}
		};
		void poll();
		const interval = setInterval(() => void poll(), 2000);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}, [client, close, pending]);

	const pageMode = Boolean(pending && pageScopes.includes(pending.scope));
	const page =
		pending && pageMode ? (
			<StepUpPage
				code={code}
				error={error}
				isSubmitting={isSubmitting}
				onClose={() => close(false)}
				onCodeChange={(value) => {
					setCode(value);
					setError(null);
				}}
				onCodeComplete={(value) => {
					if (!isSubmitting) {
						void submit(value);
					}
				}}
				onEnrol2fa={() => {
					close(false);
					onEnrol2fa();
				}}
				onMethodChange={(method) => void switchMethod(method)}
				onResend={() => {
					if (pending.method === "magic-link") {
						void switchMethod("magic-link");
					} else {
						void switchMethod("otp");
					}
				}}
				onSubmit={(event) => {
					event.preventDefault();
					void submit(code);
				}}
				pageHeader={pageHeader}
				pending={pending}
			/>
		) : null;

	const dialog = (
		<>
			{page}
			<Dialog
				disablePointerDismissal={
					pending ? isStepUpBlocking(pending.scope) : false
				}
				onOpenChange={(open) => {
					if (!open) {
						if (pending && isStepUpBlocking(pending.scope)) {
							return;
						}
						close(false);
					}
				}}
				open={pending !== null && !pageMode}
			>
				<DialogContent
					className="max-w-md"
					showCloseButton={pending ? !isStepUpBlocking(pending.scope) : true}
				>
					<DialogHeader>
						<DialogTitle>Confirm it&apos;s you</DialogTitle>
						<DialogDescription>
							{pending ? stepUpPromptLine(pending) : null}
						</DialogDescription>
					</DialogHeader>
					{pending && isStepUpBlocking(pending.scope) ? (
						<p className="text-muted-foreground text-sm">
							This confirmation stays open until you enter the current code from
							your authenticator app.
						</p>
					) : null}

					{pending?.enrolmentRequired ? (
						// Staff scopes take no emailed fallback, so there is nothing to type
						// here — the only way forward is enrolling a real second factor.
						<div className="space-y-4">
							<p className="text-muted-foreground text-sm">
								Staff actions need two-factor authentication on your account.
							</p>
							<Button
								className="w-full"
								onClick={() => {
									close(false);
									onEnrol2fa();
								}}
								size="lg"
								variant="mono"
							>
								Turn on two-factor
							</Button>
						</div>
					) : null}

					{pending &&
					!pending.enrolmentRequired &&
					pending.method === "magic-link" ? (
						<div className="space-y-4">
							<p className="text-muted-foreground text-sm">
								We sent a one-click verification link to your account email.
								Open it in this browser; this dialog will continue
								automatically.
							</p>
							{error ? (
								<p className="text-sm text-status-destructive">{error}</p>
							) : null}
							<Button
								className="w-full"
								disabled={isSubmitting}
								onClick={() => void switchMethod("magic-link")}
								size="lg"
								variant="mono"
							>
								Send the link again
							</Button>
							{pending.methods.filter((m) => m !== pending.method).length >
							0 ? (
								<div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
									{pending.methods
										.filter((method) => method !== pending.method)
										.map((method) => (
											<Button
												disabled={isSubmitting}
												key={method}
												onClick={() => void switchMethod(method)}
												size="sm"
												variant="ghost"
											>
												{STEP_UP_METHOD_LABEL[method]}
											</Button>
										))}
								</div>
							) : null}
						</div>
					) : null}

					{pending &&
					!pending.enrolmentRequired &&
					pending.method !== "magic-link" ? (
						<StepUpVerify
							code={code}
							error={error}
							isSubmitting={isSubmitting}
							method={pending.method}
							onCodeChange={(value) => {
								setCode(value);
								setError(null);
							}}
							onCodeComplete={(value) => {
								if (!isSubmitting) {
									void submit(value);
								}
							}}
							onMethodChange={(method) => void switchMethod(method)}
							onResend={() => void switchMethod("otp")}
							onSubmit={(e) => {
								e.preventDefault();
								void submit(code);
							}}
							otherMethods={pending.methods.filter((m) => m !== pending.method)}
						/>
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);

	return { dialog, guard, prompt };
}
