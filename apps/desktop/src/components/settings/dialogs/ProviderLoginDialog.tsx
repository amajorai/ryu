// apps/desktop/src/components/settings/dialogs/ProviderLoginDialog.tsx
//
// The subscription login flow (ChatGPT / Claude / Copilot), rendered.
//
// Subscription providers are connected by completing a real OAuth flow. Core
// drives pi-ai's own flow modules and streams what they emit; this dialog is the
// surface that was missing — before it, the "Login" button ran an agent-advertised
// ACP method that logs nobody in, and there was nowhere for an authorization URL,
// a device code, or a prompt to appear.
//
// Every flow shape the providers use is handled: an authorization URL to open
// (Claude), a device code to type on a verification page (Copilot), a localhost
// callback that completes on its own (ChatGPT), and prompts in between — free
// text, a pasted code, or a choice.

import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { OTPCodeDisplay } from "@ryu/ui/components/motion/otp-input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SuccessCheck } from "@ryu/ui/components/success-check.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { ApiError, toTarget } from "@/src/lib/api/client.ts";
import {
	answerProviderLogin,
	cancelProviderLogin,
	openProviderLoginStream,
	type PiLoginEvent,
	type PiLoginPrompt,
	startProviderLogin,
} from "@/src/lib/api/pi-config.ts";
import { isTauriReady } from "@/src/lib/tauri-ready.ts";

interface ProviderLoginDialogProps {
	accountId?: string;
	enablePlanUse?: boolean;
	onOpenChange: (open: boolean) => void;
	/** Called once the credential is stored, so the card can flip to Connected. */
	onSuccess: (event: PiLoginEvent) => void;
	open: boolean;
	providerId: string;
	providerLabel: string;
}

/** Prefer Core's actionable error body over the generic HTTP path/status. */
function providerLoginErrorMessage<TCause>(
	cause: TCause,
	fallback: string
): string {
	if (cause instanceof ApiError && cause.serverMessage) {
		return cause.serverMessage;
	}
	return cause instanceof Error ? cause.message : fallback;
}

export function ProviderLoginDialog({
	accountId,
	enablePlanUse = false,
	onOpenChange,
	onSuccess,
	open,
	providerId,
	providerLabel,
}: ProviderLoginDialogProps) {
	const activeNode = useActiveNode();
	// The flow-owning effect below reads the node's CREDENTIAL through a ref and
	// depends only on its URL. Depending on the token — as an object OR as a
	// string — cannot work here, and depending on the string was the mistake this
	// comment used to defend.
	//
	// `useNodeStore` refreshes cloud tokens on every window `focus`, and
	// `refreshCloudTokens` -> `fetchManagedNodes()` asks the control plane to mint
	// a node-bound delegation per call. Its `iat`/`exp` changes every time, so
	// each fetch yields a different token STRING, which
	// `decorateLocal` then writes into the active node. This flow deliberately
	// sends the user to the system browser, so a focus round-trip is guaranteed:
	// for anyone on a managed node, coming back from the consent screen changed
	// the token, re-ran the effect, and its cleanup killed the OAuth child the
	// user had just authorized — the exact abort, on the exact path, that the
	// object dependency caused.
	//
	// The URL is what identifies the target and it does not churn on refresh, so
	// it stays a real dependency: pointing the dialog at a different node SHOULD
	// restart the flow. The token is only ever needed at call time, and a ref
	// hands each call the freshest one — which matters, because the credential
	// the cleanup cancels with must not be the expired one from 15 minutes ago.
	const nodeUrl = activeNode.url;
	const nodeToken = activeNode.token ?? null;
	const nodeUserJwt = activeNode.userJwt ?? null;
	const tokenRef = useRef(nodeToken);
	const userJwtRef = useRef(nodeUserJwt);
	// Declared BEFORE the flow effect so React runs it first in every commit,
	// leaving the ref current by the time `run()` reads it.
	useEffect(() => {
		tokenRef.current = nodeToken;
		userJwtRef.current = nodeUserJwt;
	}, [nodeToken, nodeUserJwt]);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [authUrl, setAuthUrl] = useState<string | null>(null);
	const [instructions, setInstructions] = useState<string | null>(null);
	const [deviceCode, setDeviceCode] = useState<{
		userCode: string;
		verificationUri: string;
	} | null>(null);
	const [copiedDeviceCode, setCopiedDeviceCode] = useState<string | null>(null);
	const [prompt, setPrompt] = useState<{
		id: string;
		prompt: PiLoginPrompt;
	} | null>(null);
	const [answer, setAnswer] = useState("");
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [browserLaunchError, setBrowserLaunchError] = useState<string | null>(
		null
	);
	const [done, setDone] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const openInBrowser = useCallback(async (url: string) => {
		setBrowserLaunchError(null);
		try {
			await openExternal(url);
		} catch {
			setBrowserLaunchError(
				"Could not open your browser. Use the button below to retry."
			);
		}
	}, []);

	// Held in a ref so cleanup can cancel the flow without re-running the effect
	// every time the id lands in state.
	const sessionRef = useRef<string | null>(null);

	const applyEvent = useCallback(
		(event: PiLoginEvent) => {
			switch (event.type) {
				case "auth_url":
					setAuthUrl(event.url ?? null);
					setInstructions(event.instructions ?? null);
					// Opening it immediately is the whole point of the flow: the user
					// asked to log in, so put them in front of the consent screen.
					if (event.url) {
						void openInBrowser(event.url);
					}
					break;
				case "device_code":
					setCopiedDeviceCode(null);
					setDeviceCode(
						event.verificationUri && event.userCode
							? {
									userCode: event.userCode,
									verificationUri: event.verificationUri,
								}
							: null
					);
					if (event.verificationUri) {
						void openInBrowser(event.verificationUri);
					}
					break;
				case "prompt":
					if (event.id && event.prompt) {
						setPrompt({ id: event.id, prompt: event.prompt });
						setAnswer("");
					}
					break;
				case "info":
				case "progress":
					setStatus(event.message ?? null);
					break;
				case "success":
					setDone(true);
					setPrompt(null);
					setStatus(null);
					setError(null);
					toast.success({ title: `Connected ${providerLabel}` });
					onSuccess(event);
					break;
				case "error":
					setError(event.message ?? "The login failed.");
					setPrompt(null);
					break;
				default:
					break;
			}
		},
		[onSuccess, openInBrowser, providerLabel]
	);

	// One flow per opening of the dialog. Closing aborts the stream AND cancels
	// the flow server-side — these providers bind fixed localhost callback ports,
	// so a flow left running would make the next attempt fail to bind.
	//
	// This effect OWNS a subprocess lifecycle, so its dependency list is a
	// correctness surface, not a lint detail: every re-run tears down a live
	// login. `applyEvent` is intentionally absent — it is a `useCallback` over
	// `onSuccess` (itself a stable `useCallback`) and a string, so it never
	// changes in practice, and listing it would put a render-identity value in
	// charge of whether the user's sign-in survives.
	// re-running this effect kills the in-flight OAuth child; `applyEvent` is stable by construction, and the node token is read through `tokenRef` on purpose (see above).
	useEffect(() => {
		if (!open) {
			return;
		}
		const controller = new AbortController();
		let cancelled = false;
		// Resolved per call, not once: the token is whatever the last cloud
		// refresh left in the ref, which is the only one the node will still
		// accept. The url is the effect's real dependency.
		const target = () =>
			toTarget({
				token: tokenRef.current,
				url: nodeUrl,
				userJwt: userJwtRef.current,
			});

		const run = async () => {
			setAuthUrl(null);
			setInstructions(null);
			setDeviceCode(null);
			setPrompt(null);
			setStatus("Preparing sign-in…");
			setError(null);
			setBrowserLaunchError(null);
			setDone(false);
			try {
				const started = await startProviderLogin(target(), providerId, {
					accountId,
					enablePlanUse,
				});
				if (cancelled) {
					// Raced the dialog closing — do not leave the flow running.
					cancelProviderLogin(target(), started.sessionId).catch(
						() => undefined
					);
					return;
				}
				sessionRef.current = started.sessionId;
				setSessionId(started.sessionId);
				setStatus(null);
				for await (const message of openProviderLoginStream(
					target(),
					started.sessionId,
					controller.signal
				)) {
					applyEvent(message.data);
				}
			} catch (e) {
				if (!(cancelled || controller.signal.aborted)) {
					setError(providerLoginErrorMessage(e, "Could not start the login."));
				}
			}
		};
		run();

		return () => {
			cancelled = true;
			controller.abort();
			const id = sessionRef.current;
			sessionRef.current = null;
			if (id) {
				cancelProviderLogin(target(), id).catch(() => undefined);
			}
		};
	}, [open, providerId, nodeUrl, accountId, enablePlanUse]);

	const submitAnswer = async () => {
		if (!(prompt && sessionId)) {
			return;
		}
		setSubmitting(true);
		try {
			const res = await answerProviderLogin(
				toTarget(activeNode),
				sessionId,
				prompt.id,
				answer
			);
			if (res.accepted) {
				setPrompt(null);
				setStatus("Working…");
				setError(null);
			} else {
				setError(res.error ?? "The login did not accept that answer.");
			}
		} catch (e) {
			setError(providerLoginErrorMessage(e, "The answer could not be sent."));
		} finally {
			setSubmitting(false);
		}
	};

	const selectOptions = prompt?.prompt.options ?? [];
	const isSelect = prompt?.prompt.type === "select" && selectOptions.length > 0;
	const settled = done || error !== null;

	// Base UI's `Dialog.Root` dismisses on backdrop click and on Escape, and
	// dismissal here does not merely hide a panel: it runs the effect cleanup,
	// which kills the OAuth child and drops its callback port. The gesture that
	// triggers it is the ordinary one for re-focusing the app window after the
	// browser — precisely what this flow asks the user to do — so an accidental
	// click was enough to abort a sign-in that had already been authorized.
	// Only a settled flow closes itself; until then the Cancel button below is
	// the deliberate way out, and it stays wired straight to `onOpenChange` so a
	// wedged flow can never trap the user.
	const handleOpenChange = (next: boolean) => {
		if (next || settled) {
			onOpenChange(next);
		}
	};

	const copyDeviceCode = async (code: string) => {
		try {
			await navigator.clipboard.writeText(code);
			setCopiedDeviceCode(code);
			toast.success("Device code copied");
		} catch {
			toast.error("Couldn't copy the device code");
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg" showCloseButton={settled}>
				<DialogHeader>
					<DialogTitle>Sign in to {providerLabel}</DialogTitle>
					<DialogDescription>
						Authorize Ryu in your browser, then come back here. This window
						stays open until the sign-in finishes — use Cancel to stop it.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					{done ? (
						<div className="flex items-center gap-3">
							<span className="inline-flex shrink-0 text-status-success">
								<SuccessCheck className="size-8" />
							</span>
							<p className="text-sm">
								Connected. {providerLabel} is ready to use.
							</p>
						</div>
					) : null}

					{error ? (
						<p className="text-sm text-status-destructive">{error}</p>
					) : null}

					{browserLaunchError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{browserLaunchError}
						</p>
					) : null}

					{authUrl && !done ? (
						<div className="flex flex-col gap-2">
							<p className="text-muted-foreground text-xs">
								{instructions ??
									"Your browser should have opened. If it didn't, use the button below."}
							</p>
							<Button
								onClick={(event) => {
									if (isTauriReady()) {
										event.preventDefault();
										void openInBrowser(authUrl);
									}
								}}
								render={
									<a
										href={/^https?:\/\//.test(authUrl) ? authUrl : undefined}
										rel="noopener noreferrer"
										target="_blank"
									/>
								}
								size="sm"
								variant="ghost"
							>
								Open the authorization page
							</Button>
						</div>
					) : null}

					{deviceCode && !done ? (
						<div className="flex flex-col gap-2">
							<p className="text-muted-foreground text-xs">
								Enter this code on the verification page:
							</p>
							<div className="flex items-center gap-2">
								<OTPCodeDisplay
									aria-label={`${providerLabel} device code`}
									code={deviceCode.userCode}
									size="compact"
								/>
								<Button
									onClick={() => void copyDeviceCode(deviceCode.userCode)}
									size="sm"
									variant="outline"
								>
									{copiedDeviceCode === deviceCode.userCode
										? "Copied"
										: "Copy code"}
								</Button>
							</div>
							<Button
								onClick={() => void openInBrowser(deviceCode.verificationUri)}
								size="sm"
								variant="ghost"
							>
								Open the verification page
							</Button>
						</div>
					) : null}

					{prompt && !done ? (
						<div className="flex flex-col gap-2">
							<Label htmlFor="provider-login-answer">
								{prompt.prompt.message}
							</Label>
							{isSelect ? (
								<div className="flex flex-col gap-2">
									{selectOptions.map((option) => (
										<Button
											disabled={submitting}
											key={option.id}
											onClick={() => {
												setAnswer(option.id);
												// The flow matches on the option id, so send it
												// directly rather than routing through the text box.
												setSubmitting(true);
												answerProviderLogin(
													toTarget(activeNode),
													sessionId ?? "",
													prompt.id,
													option.id
												)
													.then((res) => {
														if (res.accepted) {
															setPrompt(null);
															setStatus("Working…");
															// Same as a typed answer: an accepted choice
															// retires an earlier refusal, so the running
															// flow is not shown as settled (and dismissible).
															setError(null);
														} else {
															setError(res.error ?? "That choice was refused.");
														}
													})
													.catch((e) => {
														setError(
															providerLoginErrorMessage(
																e,
																"The choice could not be sent."
															)
														);
													})
													.finally(() => setSubmitting(false));
											}}
											size="sm"
											variant="ghost"
										>
											{option.label}
										</Button>
									))}
								</div>
							) : (
								<div className="flex gap-2">
									<Input
										autoFocus
										id="provider-login-answer"
										onChange={(e) => setAnswer(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												submitAnswer();
											}
										}}
										placeholder={prompt.prompt.placeholder ?? ""}
										value={answer}
									/>
									<Button
										disabled={submitting}
										onClick={submitAnswer}
										size="sm"
									>
										{submitting ? "Sending…" : "Continue"}
									</Button>
								</div>
							)}
						</div>
					) : null}

					{status && !(done || error) ? (
						<p className="text-muted-foreground text-xs">{status}</p>
					) : null}
				</div>

				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						size="sm"
						variant={done ? "default" : "outline"}
					>
						{done ? "Done" : "Cancel"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
