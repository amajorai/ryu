import {
	Loading03Icon,
	Plug01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import type { ConsentActions } from "../consent-host-context.tsx";
import {
	CARD_CLASS,
	type ConsentFollowUp,
	errorMessage,
	InlineError,
	isAbort,
	ListingIcon,
	useDecisionDelivery,
} from "./consent-cards-shared.tsx";
import {
	type ConnectAppInfo,
	type ConnectAppRequest,
	connectFollowUp,
	type UnavailableKind,
} from "./consent-tool.ts";

type ConnectPhase =
	| { kind: "idle" }
	| { kind: "connecting" }
	| { kind: "failed"; message: string };

type AppInfoState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; info: ConnectAppInfo };

/**
 * The agent asks the user to connect an app account. The user picks the access
 * ceiling, Connect opens the provider's sign-in in the browser, and the card
 * tells the agent to continue once the account is connected.
 */
export const ConnectAppCard = memo(function ConnectAppCard({
	actions,
	onFollowUp,
	request,
	toolCallId,
}: {
	actions: ConsentActions;
	onFollowUp: ConsentFollowUp;
	request: ConnectAppRequest;
	/** Keys the remembered decision, so a reopened chat keeps the card closed. */
	toolCallId?: string;
}) {
	const tl = useLiteralMessages();
	const [state, setState] = useState<AppInfoState>({ status: "loading" });
	const [phase, setPhase] = useState<ConnectPhase>({ kind: "idle" });
	const [accessLevel, setAccessLevel] = useState(
		() => actions.accessOptions[0]?.id ?? ""
	);
	const { decision, deliver, pending, retry, sending } = useDecisionDelivery(
		toolCallId,
		onFollowUp
	);
	const controllerRef = useRef<AbortController | null>(null);
	// Set once a sign-in was opened from this card: the browser flow can still
	// finish after the card stopped waiting, so a later "Not now" re-checks first.
	const signInOpenedRef = useRef(false);
	const [lookupAttempt, setLookupAttempt] = useState(0);
	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const requestRef = useRef(request);
	requestRef.current = request;
	const requestKey = JSON.stringify([
		request.provider,
		request.app,
		request.pluginId,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: requestKey, nodeKey and lookupAttempt are the identity; the refs carry the latest values.
	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		controllerRef.current?.abort();
		actionsRef.current
			.describeApp(requestRef.current)
			.then((info) => {
				if (!cancelled) {
					setState({ status: "ready", info });
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setState({
						status: "error",
						message: errorMessage(error, "Couldn't check this connection."),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [requestKey, actions.nodeKey, lookupAttempt]);

	// Abandon a pending sign-in wait when the card goes away.
	useEffect(() => () => controllerRef.current?.abort(), []);

	const info = state.status === "ready" ? state.info : null;
	// The host resolves the name from the toolkit or installed plugin; the
	// fallback is the slug the connection will actually use.
	const name = info?.name || request.app;

	const finishConnected = () =>
		deliver({ kind: "connected" }, connectFollowUp(request.app, "connected"));

	const connect = async () => {
		const controller = new AbortController();
		controllerRef.current = controller;
		signInOpenedRef.current = true;
		setPhase({ kind: "connecting" });
		try {
			await actions.connectApp(request, accessLevel, controller.signal);
			setPhase({ kind: "idle" });
			await finishConnected();
		} catch (error) {
			setPhase(
				isAbort(error) || controller.signal.aborted
					? { kind: "idle" }
					: {
							kind: "failed",
							message: errorMessage(
								error,
								tl("Couldn't connect {name}.", { name })
							),
						}
			);
		} finally {
			if (controllerRef.current === controller) {
				controllerRef.current = null;
			}
		}
	};

	// Stops waiting here only; the sign-in page may still be open in the
	// browser, which is why `decline` re-checks before refusing.
	const stopWaiting = () => controllerRef.current?.abort();

	const decline = async () => {
		if (signInOpenedRef.current) {
			try {
				const latest = await actions.describeApp(request);
				if (latest.connected) {
					// The user finished signing in after all: show that instead of
					// sending a refusal that contradicts the stored connection.
					setState({ status: "ready", info: latest });
					return;
				}
			} catch {
				// Can't tell; the user's explicit "Not now" stands.
			}
		}
		await deliver(
			{ kind: "declined" },
			connectFollowUp(request.app, "declined")
		);
	};

	const reportUnavailable = (kind: UnavailableKind | null) =>
		deliver(
			{ kind: "unavailable" },
			connectFollowUp(request.app, "unavailable", kind)
		);

	const selectedAccess = actions.accessOptions.find(
		(option) => option.id === accessLevel
	);
	const connectedNow =
		decision?.kind === "connected" || pending?.decision.kind === "connected";
	let status: ReactNode = null;
	let controls: ReactNode = null;
	if (pending?.error) {
		status = <InlineError message={pending.error} />;
		controls = (
			<Button disabled={sending} onClick={retry} size="xs" variant="outline">
				Send again
			</Button>
		);
	} else if (connectedNow) {
		status = (
			<span className="flex items-center gap-1.5 text-status-success text-xs">
				<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
				Connected
			</span>
		);
	} else if (decision?.kind === "declined") {
		status = (
			<span className="text-muted-foreground text-xs">You declined.</span>
		);
	} else if (decision?.kind === "unavailable") {
		status = (
			<span className="text-muted-foreground text-xs">
				{tl("{name} can't be connected here. The agent was told why.", {
					name,
				})}
			</span>
		);
	} else if (state.status === "loading") {
		status = (
			<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<HugeiconsIcon
					aria-hidden
					className="size-3.5 animate-spin"
					icon={Loading03Icon}
				/>
				Checking connection
			</span>
		);
	} else if (phase.kind === "connecting") {
		status = (
			<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<HugeiconsIcon
					aria-hidden
					className="size-3.5 animate-spin"
					icon={Loading03Icon}
				/>
				{tl("Finish signing in to {name} in your browser", { name })}
			</span>
		);
		controls = (
			<Button onClick={stopWaiting} size="xs" variant="ghost">
				Stop waiting
			</Button>
		);
	} else if (state.status === "error") {
		// The app couldn't be looked up, so there is nothing reviewed to connect
		// to yet: offer a retry, never a Connect built from the request alone.
		status = <InlineError message={state.message} />;
		controls = (
			<Button
				onClick={() => setLookupAttempt((attempt) => attempt + 1)}
				size="xs"
				variant="outline"
			>
				Check again
			</Button>
		);
	} else if (info && !info.available) {
		const reason =
			info.unavailableReason ?? tl("{name} can't be connected here.", { name });
		status = <span className="text-muted-foreground text-xs">{reason}</span>;
		controls = (
			<Button
				disabled={sending}
				onClick={() => reportUnavailable(info.unavailableKind)}
				size="xs"
				variant="ghost"
			>
				Let the agent know
			</Button>
		);
	} else if (info?.connected) {
		status = (
			<span className="flex items-center gap-1.5 text-status-success text-xs">
				<HugeiconsIcon aria-hidden className="size-3.5" icon={Tick02Icon} />
				Already connected
			</span>
		);
		controls = (
			<Button
				disabled={sending}
				onClick={finishConnected}
				size="xs"
				variant="outline"
			>
				Continue
			</Button>
		);
	} else {
		status =
			phase.kind === "failed" ? (
				<InlineError message={phase.message} />
			) : (
				<span className="text-muted-foreground text-xs">
					{tl(
						"You'll sign in on {name}'s own page. Ryu never sees your password.",
						{ name }
					)}
				</span>
			);
		controls = (
			<>
				<Button disabled={sending} onClick={decline} size="xs" variant="ghost">
					Not now
				</Button>
				<Button disabled={sending} onClick={connect} size="xs">
					{phase.kind === "failed"
						? "Try again"
						: tl("Connect {name}", { name })}
				</Button>
			</>
		);
	}

	const choosingAccess =
		!(decision || pending || info?.connected) &&
		info?.available === true &&
		phase.kind !== "connecting" &&
		actions.accessOptions.length > 1;

	return (
		<section
			aria-label={tl("Connect {name}", { name })}
			className={CARD_CLASS}
			data-testid="consent-connect-card"
		>
			<div className="flex items-start gap-3 px-3 pt-3 pb-2">
				<ListingIcon name={name} url={info?.logoUrl ?? null} />
				<div className="min-w-0 flex-1">
					<p className="flex items-center gap-1.5 font-medium">
						<HugeiconsIcon
							aria-hidden
							className="size-3.5 text-muted-foreground"
							icon={Plug01Icon}
						/>
						{tl("Connect {name}?", { name })}
					</p>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{request.reason}
					</p>
				</div>
			</div>
			{choosingAccess ? (
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2">
					<label
						className="text-muted-foreground text-xs"
						htmlFor={`consent-access-${toolCallId ?? request.app}`}
					>
						What Ryu may do
					</label>
					<NativeSelect
						appearance="dense"
						id={`consent-access-${toolCallId ?? request.app}`}
						onChange={(event) => setAccessLevel(event.target.value)}
						size="sm"
						value={accessLevel}
					>
						{actions.accessOptions.map((option) => (
							<NativeSelectOption key={option.id} value={option.id}>
								{option.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
					{selectedAccess ? (
						<p className="w-full text-muted-foreground text-xs">
							{selectedAccess.description}
						</p>
					) : null}
				</div>
			) : null}
			<div
				aria-live="polite"
				className="flex flex-wrap items-center justify-between gap-2 border-border border-t px-3 py-2"
			>
				<div className="min-w-0 flex-1">{status}</div>
				{controls ? (
					<div className="flex shrink-0 items-center gap-1.5">{controls}</div>
				) : null}
			</div>
		</section>
	);
});
