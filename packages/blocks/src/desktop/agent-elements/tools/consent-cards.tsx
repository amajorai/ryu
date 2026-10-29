import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";
import { VerificationPopover } from "@ryu/ui/components/verification-popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	IconAlertTriangle,
	IconCheck,
	IconDownload,
	IconLoader2,
	IconPlug,
	IconPuzzle,
	IconStarFilled,
} from "@tabler/icons-react";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import type { ConsentActions } from "../consent-host-context.tsx";
import {
	type ConsentDecision,
	readConsentDecision,
	writeConsentDecision,
} from "./consent-decisions.ts";
import {
	type ConnectAppInfo,
	type ConnectAppRequest,
	type ConsentPluginCandidate,
	connectFollowUp,
	formatCompactCount,
	formatRating,
	installFollowUp,
	type PluginInstallRequest,
	type PluginTrustTier,
	rankPluginCandidates,
	type UnavailableKind,
} from "./consent-tool.ts";

/** Sends the user's decision back to the agent as their next message. */
export type ConsentFollowUp = (text: string) => void | Promise<void>;

const TIER_LABEL = {
	official: "Official",
	verified: "Verified",
	community: "Community",
} satisfies Record<PluginTrustTier, string>;

const TIER_DESCRIPTION = {
	official: "Published by Ryu. Officially verified by Ryu staff.",
	verified: "The publisher's identity has been verified.",
	community:
		"Community publisher. Ryu has not verified who publishes this plugin.",
} satisfies Record<PluginTrustTier, string>;

const TIER_APPEARANCE = {
	official: "publisher-gold-card",
	verified: "publisher-blue-card",
	community: "publisher-dotted",
} as const satisfies Record<PluginTrustTier, string>;

const TIER_TEXT = {
	official:
		"text-publisher-verification-gold dark:text-publisher-verification-gold-dark",
	verified: "text-status-info",
	community: "text-muted-foreground",
} satisfies Record<PluginTrustTier, string>;

const CARD_CLASS = "rounded-xl border border-border/60 bg-card/60 text-sm";

function isHttpUrl(value: string | null): value is string {
	return Boolean(value && /^https?:\/\//i.test(value));
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function ListingIcon({ name, url }: { name: string; url: string | null }) {
	if (isHttpUrl(url)) {
		return (
			<img
				alt=""
				className="size-9 shrink-0 rounded-lg border border-border/60 bg-background object-contain"
				height={36}
				loading="lazy"
				referrerPolicy="no-referrer"
				src={url}
				width={36}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted font-medium text-muted-foreground"
		>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

/** Publisher trust mark plus its tier word, using the store's verification marks. */
export function TrustTierMark({ tier }: { tier: PluginTrustTier }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-0.5 text-xs",
				TIER_TEXT[tier]
			)}
			data-tier={tier}
		>
			<VerificationPopover
				appearance={TIER_APPEARANCE[tier]}
				description={TIER_DESCRIPTION[tier]}
				details={
					tier === "community"
						? { methods: [] }
						: {
								methods: [
									{
										kind: tier === "official" ? "organization" : "identity",
										label: TIER_DESCRIPTION[tier],
									},
								],
							}
				}
				label={`${TIER_LABEL[tier]} publisher`}
				title={`${TIER_LABEL[tier]} publisher`}
				variant="badge"
			/>
			{TIER_LABEL[tier]}
		</span>
	);
}

/** Rating, installs, stars, version and author on one quiet line. */
export function PluginStats({
	candidate,
}: {
	candidate: ConsentPluginCandidate;
}) {
	const rating = formatRating(candidate.ratingAverage, candidate.ratingCount);
	const ratingCount = formatCompactCount(candidate.ratingCount);
	const downloads = formatCompactCount(candidate.downloads);
	const stars = formatCompactCount(candidate.stars);
	const items: { key: string; node: ReactNode; label: string }[] = [];
	if (rating) {
		items.push({
			key: "rating",
			label: `Rated ${rating} out of 5 from ${ratingCount} reviews`,
			node: (
				<>
					<IconStarFilled aria-hidden className="size-3 text-amber-500" />
					{rating}
					<span className="text-muted-foreground/70">({ratingCount})</span>
				</>
			),
		});
	}
	if (downloads) {
		items.push({
			key: "downloads",
			label: `${downloads} installs`,
			node: (
				<>
					<IconDownload aria-hidden className="size-3" />
					{downloads}
				</>
			),
		});
	}
	if (stars) {
		items.push({
			key: "stars",
			label: `${stars} GitHub stars`,
			node: `${stars} stars`,
		});
	}
	if (candidate.version) {
		items.push({
			key: "version",
			label: `Version ${candidate.version}`,
			node: `v${candidate.version}`,
		});
	}
	if (candidate.author) {
		items.push({
			key: "author",
			label: `By ${candidate.author}`,
			node: `by ${candidate.author}`,
		});
	}
	if (items.length === 0) {
		return (
			<p className="text-muted-foreground/70 text-xs">
				No ratings or installs yet
			</p>
		);
	}
	return (
		<ul
			aria-label="Plugin stats"
			className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-muted-foreground text-xs tabular-nums"
		>
			{items.map((item) => (
				<li
					aria-label={item.label}
					className="inline-flex items-center gap-1"
					key={item.key}
				>
					{item.node}
				</li>
			))}
		</ul>
	);
}

function CardHeader({
	icon,
	reason,
	title,
}: {
	icon: ReactNode;
	reason: string;
	title: string;
}) {
	return (
		<div className="flex items-start gap-2.5 px-3 pt-3 pb-2">
			<span
				aria-hidden="true"
				className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground"
			>
				{icon}
			</span>
			<div className="min-w-0 flex-1">
				<p className="font-medium">{title}</p>
				<p className="mt-0.5 text-muted-foreground text-xs">{reason}</p>
			</div>
		</div>
	);
}

function InlineError({ message }: { message: string }) {
	return (
		<p
			className="flex items-center gap-1.5 text-status-destructive text-xs"
			role="alert"
		>
			<IconAlertTriangle aria-hidden className="size-3.5 shrink-0" />
			{message}
		</p>
	);
}

type PluginListState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; candidates: ConsentPluginCandidate[] };

/** A decision whose message to the agent has not been delivered yet. */
interface PendingDelivery {
	decision: ConsentDecision;
	error: string | null;
	text: string;
}

/**
 * The card's final decision and its delivery to the agent.
 *
 * A decision is remembered (and the card closes) only after the follow-up
 * message was handed to the chat. If sending fails, the card keeps a retry so
 * the agent, which ended its turn to wait, always hears the answer.
 */
function useDecisionDelivery(
	toolCallId: string | undefined,
	onFollowUp: ConsentFollowUp
) {
	const [decision, setDecision] = useState<ConsentDecision | null>(() =>
		readConsentDecision(toolCallId)
	);
	const [pending, setPending] = useState<PendingDelivery | null>(null);
	const [sending, setSending] = useState(false);

	const deliver = async (next: ConsentDecision, text: string) => {
		setSending(true);
		setPending({ decision: next, error: null, text });
		try {
			await onFollowUp(text);
			setDecision(next);
			setPending(null);
			writeConsentDecision(toolCallId, next);
		} catch (error) {
			setPending({
				decision: next,
				error: errorMessage(error, "Couldn't send your answer to the agent."),
				text,
			});
		} finally {
			setSending(false);
		}
	};

	const retry = () =>
		pending ? deliver(pending.decision, pending.text) : null;

	return { decision, deliver, pending, retry, sending };
}

function DeliveryRetry({
	error,
	onRetry,
	sending,
}: {
	error: string;
	onRetry: () => void;
	sending: boolean;
}) {
	return (
		<div className="flex items-center justify-between gap-2 border-border/50 border-t px-3 py-2">
			<InlineError message={error} />
			<Button disabled={sending} onClick={onRetry} size="xs" variant="outline">
				Send again
			</Button>
		</div>
	);
}

function PluginRow({
	busy,
	candidate,
	disabled,
	error,
	installedHere,
	onInstall,
	onOpenStore,
	onReview,
	onUse,
	recommended,
}: {
	busy: boolean;
	candidate: ConsentPluginCandidate;
	disabled: boolean;
	error: string | null;
	installedHere: boolean;
	onInstall: () => void;
	onOpenStore: () => void;
	onReview: () => void;
	onUse: () => void;
	recommended: boolean;
}) {
	const installed = candidate.installed || installedHere;
	const turnedOff = candidate.installed && !candidate.enabled;
	let action: ReactNode = null;
	let note: string | null = null;
	if (installedHere) {
		action = (
			<Badge variant="secondary">
				<IconCheck aria-hidden />
				Installed
			</Badge>
		);
	} else if (candidate.storeOnly) {
		// Checked before the installed state: that is matched by id only, so a
		// same-id package installed from another marketplace must not make this
		// listing look installed.
		note =
			"Listed in another marketplace. Install it from the Store, where you can see which one.";
		action = (
			<Button
				disabled={disabled}
				onClick={onOpenStore}
				size="xs"
				variant="outline"
			>
				Open in Store
			</Button>
		);
	} else if (turnedOff) {
		note =
			"Installed but turned off. Turn it on in the Store to review its permissions.";
		action = (
			<Button
				disabled={disabled}
				onClick={onOpenStore}
				size="xs"
				variant="outline"
			>
				Open in Store
			</Button>
		);
	} else if (installed) {
		action = (
			<Button disabled={disabled} onClick={onUse} size="xs" variant="outline">
				Use it
			</Button>
		);
	} else if (candidate.installable) {
		action = (
			<Button
				disabled={disabled || busy}
				onClick={onInstall}
				size="xs"
				variant={recommended ? "default" : "outline"}
			>
				{busy ? (
					<IconLoader2 aria-hidden className="size-3.5 animate-spin" />
				) : null}
				{busy ? "Installing" : "Install"}
			</Button>
		);
	} else if (candidate.reviewUrl) {
		note =
			"Community plugins can't be installed from chat. Review the source first, then install it from the Store.";
		action = (
			<Button disabled={disabled} onClick={onReview} size="xs" variant="ghost">
				Review
			</Button>
		);
	} else {
		note =
			"Can't be installed from chat, and the listing has no source link to review.";
	}
	return (
		<li
			className="flex items-start gap-3 px-3 py-2.5"
			data-plugin-id={candidate.id}
			data-testid="consent-plugin-row"
			data-tier={candidate.tier}
		>
			<ListingIcon name={candidate.name} url={candidate.iconUrl} />
			<div className="min-w-0 flex-1 space-y-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<p className="truncate font-medium" title={candidate.name}>
						{candidate.name}
					</p>
					<TrustTierMark tier={candidate.tier} />
					{recommended && !installed ? (
						<Badge variant="outline">Recommended</Badge>
					) : null}
					{candidate.reviewed === false ? (
						<Badge className="text-status-warning" variant="outline">
							Not reviewed by Ryu
						</Badge>
					) : null}
				</div>
				{candidate.description ? (
					<p className="line-clamp-1 text-muted-foreground text-xs">
						{candidate.description}
					</p>
				) : null}
				<PluginStats candidate={candidate} />
				{note ? (
					<p className="text-muted-foreground/80 text-xs">{note}</p>
				) : null}
				{error ? <InlineError message={error} /> : null}
			</div>
			{action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
		</li>
	);
}

/** A plugin that is installed but still off, waiting for the user to turn it on. */
interface EnableStep {
	candidate: ConsentPluginCandidate;
	checking: boolean;
	message: string | null;
}

/**
 * The agent asks the user to install a plugin. Matching catalog plugins are
 * listed official first, then verified, then community, each with its
 * publisher mark and reputation. The agent hears back only once the plugin is
 * installed and turned on, or the user declines.
 */
export const PluginInstallCard = memo(function PluginInstallCard({
	actions,
	onFollowUp,
	request,
	toolCallId,
}: {
	actions: ConsentActions;
	onFollowUp: ConsentFollowUp;
	request: PluginInstallRequest;
	/** Keys the remembered decision, so a reopened chat keeps the card closed. */
	toolCallId?: string;
}) {
	const [list, setList] = useState<PluginListState>({ status: "loading" });
	const [busyId, setBusyId] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ id: string; message: string }>();
	const [enableStep, setEnableStep] = useState<EnableStep | null>(null);
	const [lookupAttempt, setLookupAttempt] = useState(0);
	const { decision, deliver, pending, retry, sending } = useDecisionDelivery(
		toolCallId,
		onFollowUp
	);
	const requestKey = JSON.stringify([request.query, request.pluginIds]);
	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const requestRef = useRef(request);
	requestRef.current = request;

	// Reload when the request or the node changes: candidates, installed state
	// and any half-finished step all belong to the node they were read from.
	// biome-ignore lint/correctness/useExhaustiveDependencies: requestKey, nodeKey and lookupAttempt are the identity; the refs carry the latest values.
	useEffect(() => {
		let cancelled = false;
		setList({ status: "loading" });
		setEnableStep(null);
		setRowError(undefined);
		actionsRef.current
			.findPlugins(requestRef.current)
			.then((found) => {
				if (!cancelled) {
					setList({ status: "ready", candidates: rankPluginCandidates(found) });
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setList({
						status: "error",
						message: errorMessage(error, "Couldn't search the plugin catalog."),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [requestKey, actions.nodeKey, lookupAttempt]);

	const finishInstalled = (candidate: ConsentPluginCandidate, fresh: boolean) =>
		deliver(
			{ id: candidate.id, kind: "installed" },
			installFollowUp(candidate.id, fresh ? "installed" : "ready")
		);

	const install = async (candidate: ConsentPluginCandidate) => {
		setBusyId(candidate.id);
		setRowError(undefined);
		try {
			const { enabled } = await actions.installPlugin(candidate);
			if (enabled) {
				await finishInstalled(candidate, true);
			} else {
				setEnableStep({ candidate, checking: false, message: null });
			}
		} catch (error) {
			setRowError({
				id: candidate.id,
				message: errorMessage(error, "Install failed."),
			});
		} finally {
			setBusyId(null);
		}
	};

	const openStore = (candidate: ConsentPluginCandidate) => {
		setEnableStep({ candidate, checking: false, message: null });
		actions.openPluginListing(candidate);
	};

	const confirmTurnedOn = async () => {
		if (!enableStep) {
			return;
		}
		const { candidate } = enableStep;
		setEnableStep({ candidate, checking: true, message: null });
		try {
			if (await actions.isPluginEnabled(candidate)) {
				setEnableStep(null);
				await finishInstalled(candidate, true);
				return;
			}
			setEnableStep({
				candidate,
				checking: false,
				message: candidate.storeOnly
					? `${candidate.name} isn't installed and turned on yet.`
					: `${candidate.name} is still turned off.`,
			});
		} catch (error) {
			setEnableStep({
				candidate,
				checking: false,
				message: errorMessage(error, "Couldn't check the plugin."),
			});
		}
	};

	const decline = () =>
		deliver({ kind: "declined" }, installFollowUp(null, "declined"));

	const decided = decision !== null;
	const locked = decided || sending || pending !== null || busyId !== null;
	const installedId =
		decision?.kind === "installed"
			? decision.id
			: (enableStep?.candidate.id ?? null);
	let body: ReactNode;
	if (list.status === "loading") {
		body = (
			<p className="flex items-center gap-2 px-3 pb-3 text-muted-foreground text-xs">
				<IconLoader2 aria-hidden className="size-3.5 animate-spin" />
				Searching the plugin catalog
			</p>
		);
	} else if (list.status === "error") {
		// The agent is waiting on this card: a passing outage must not leave
		// "Not now" as the only way forward.
		body = (
			<div className="flex items-center justify-between gap-2 px-3 pb-3">
				<InlineError message={list.message} />
				<Button
					onClick={() => setLookupAttempt((attempt) => attempt + 1)}
					size="xs"
					variant="outline"
				>
					Check again
				</Button>
			</div>
		);
	} else if (list.candidates.length === 0) {
		body = (
			<p className="px-3 pb-3 text-muted-foreground text-xs">
				No matching plugins in the catalog
				{request.query ? ` for "${request.query}"` : ""}.
			</p>
		);
	} else {
		const firstInstallable = list.candidates.find(
			(candidate) => candidate.installable && !candidate.installed
		);
		body = (
			<ul className="divide-y divide-border/50 border-border/50 border-t">
				{list.candidates.map((candidate) => (
					<PluginRow
						busy={busyId === candidate.id}
						candidate={candidate}
						disabled={locked}
						error={rowError?.id === candidate.id ? rowError.message : null}
						installedHere={installedId === candidate.id}
						key={candidate.id}
						onInstall={() => install(candidate)}
						onOpenStore={() => openStore(candidate)}
						onReview={() => actions.openPluginListing(candidate)}
						onUse={() => finishInstalled(candidate, false)}
						recommended={candidate === firstInstallable}
					/>
				))}
			</ul>
		);
	}

	let footer: ReactNode;
	if (pending?.error) {
		footer = (
			<DeliveryRetry error={pending.error} onRetry={retry} sending={sending} />
		);
	} else if (enableStep && !decided) {
		footer = (
			<div className="space-y-2 border-border/50 border-t px-3 py-2">
				<p className="text-muted-foreground text-xs">
					{enableStep.candidate.storeOnly
						? `Install ${enableStep.candidate.name} in the Store and turn it on, then come back here.`
						: `${enableStep.candidate.name} is installed but turned off. Turn it on in the Store, where you review its permissions, then come back here.`}
				</p>
				{enableStep.message ? (
					<InlineError message={enableStep.message} />
				) : null}
				<div className="flex flex-wrap items-center justify-end gap-1.5">
					{/* Reviewing permissions may end in "no": keep a way to say so. */}
					<Button
						disabled={enableStep.checking || sending}
						onClick={decline}
						size="xs"
						variant="ghost"
					>
						Not now
					</Button>
					<Button
						disabled={sending}
						onClick={() => actions.openPluginListing(enableStep.candidate)}
						size="xs"
						variant="ghost"
					>
						Open in Store
					</Button>
					<Button
						disabled={enableStep.checking || sending}
						onClick={confirmTurnedOn}
						size="xs"
					>
						{enableStep.checking
							? "Checking"
							: enableStep.candidate.storeOnly
								? "It's installed and on"
								: "I've turned it on"}
					</Button>
				</div>
			</div>
		);
	} else {
		footer = (
			<div className="flex items-center justify-between gap-3 border-border/50 border-t px-3 py-2">
				<p className="text-muted-foreground/80 text-xs">
					{decision?.kind === "declined"
						? "You declined."
						: "Official first, then verified, then community."}
				</p>
				{decided ? null : (
					<Button disabled={locked} onClick={decline} size="xs" variant="ghost">
						Not now
					</Button>
				)}
			</div>
		);
	}

	return (
		<section
			aria-label="Plugin install request"
			className={CARD_CLASS}
			data-testid="consent-install-card"
		>
			<CardHeader
				icon={<IconPuzzle className="size-4" />}
				reason={request.reason}
				title="Install a plugin?"
			/>
			{body}
			{footer}
		</section>
	);
});

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
							message: errorMessage(error, `Couldn't connect ${name}.`),
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
				<IconCheck aria-hidden className="size-3.5" />
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
				{name} can't be connected here. The agent was told why.
			</span>
		);
	} else if (state.status === "loading") {
		status = (
			<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<IconLoader2 aria-hidden className="size-3.5 animate-spin" />
				Checking connection
			</span>
		);
	} else if (phase.kind === "connecting") {
		status = (
			<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<IconLoader2 aria-hidden className="size-3.5 animate-spin" />
				Finish signing in to {name} in your browser
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
		const reason = info.unavailableReason ?? `${name} can't be connected here.`;
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
				<IconCheck aria-hidden className="size-3.5" />
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
					You'll sign in on {name}'s own page. Ryu never sees your password.
				</span>
			);
		controls = (
			<>
				<Button disabled={sending} onClick={decline} size="xs" variant="ghost">
					Not now
				</Button>
				<Button disabled={sending} onClick={connect} size="xs">
					{phase.kind === "failed" ? "Try again" : `Connect ${name}`}
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
			aria-label={`Connect ${name}`}
			className={CARD_CLASS}
			data-testid="consent-connect-card"
		>
			<div className="flex items-start gap-3 px-3 pt-3 pb-2">
				<ListingIcon name={name} url={info?.logoUrl ?? null} />
				<div className="min-w-0 flex-1">
					<p className="flex items-center gap-1.5 font-medium">
						<IconPlug aria-hidden className="size-3.5 text-muted-foreground" />
						Connect {name}?
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
						<p className="w-full text-muted-foreground/80 text-xs">
							{selectedAccess.description}
						</p>
					) : null}
				</div>
			) : null}
			<div
				aria-live="polite"
				className="flex flex-wrap items-center justify-between gap-2 border-border/50 border-t px-3 py-2"
			>
				<div className="min-w-0 flex-1">{status}</div>
				{controls ? (
					<div className="flex shrink-0 items-center gap-1.5">{controls}</div>
				) : null}
			</div>
		</section>
	);
});

/** Read-only card for chats that can't act on a request or send the answer back. */
export function ConsentUnavailableCard({
	reason,
	title,
}: {
	reason: string;
	title: string;
}) {
	return (
		<section aria-label={title} className={CARD_CLASS}>
			<CardHeader
				icon={<IconPlug className="size-4" />}
				reason={reason}
				title={title}
			/>
			<p className="border-border/50 border-t px-3 py-2 text-muted-foreground text-xs">
				This chat can't act on the request. Connect or install it from the Store
				in Ryu, then reply here so the agent can continue.
			</p>
		</section>
	);
}
