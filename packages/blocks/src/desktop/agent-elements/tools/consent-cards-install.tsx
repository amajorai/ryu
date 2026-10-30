import { Loading03Icon, PuzzleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import type { ConsentActions } from "../consent-host-context.tsx";
import { PluginRow } from "./consent-cards-plugin-row.tsx";
import {
	CARD_CLASS,
	CardHeader,
	type ConsentFollowUp,
	DeliveryRetry,
	errorMessage,
	InlineError,
	type PluginListState,
	useDecisionDelivery,
} from "./consent-cards-shared.tsx";
import {
	type ConsentPluginCandidate,
	installFollowUp,
	type PluginInstallRequest,
	rankPluginCandidates,
} from "./consent-tool.ts";

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
	const tl = useLiteralMessages();
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
					? tl("{name} isn't installed and turned on yet.", {
							name: candidate.name,
						})
					: tl("{name} is still turned off.", { name: candidate.name }),
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
				<HugeiconsIcon
					aria-hidden
					className="size-3.5 animate-spin"
					icon={Loading03Icon}
				/>
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
				{request.query
					? tl('No matching plugins in the catalog for "{query}".', {
							query: request.query,
						})
					: tl("No matching plugins in the catalog.")}
			</p>
		);
	} else {
		const firstInstallable = list.candidates.find(
			(candidate) => candidate.installable && !candidate.installed
		);
		body = (
			<ul className="divide-y divide-border/50 border-border border-t">
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
			<div className="space-y-2 border-border border-t px-3 py-2">
				<p className="text-muted-foreground text-xs">
					{enableStep.candidate.storeOnly
						? tl(
								"Install {name} in the Store and turn it on, then come back here.",
								{ name: enableStep.candidate.name }
							)
						: tl(
								"{name} is installed but turned off. Turn it on in the Store, where you review its permissions, then come back here.",
								{ name: enableStep.candidate.name }
							)}
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
			<div className="flex items-center justify-between gap-3 border-border border-t px-3 py-2">
				<p className="text-muted-foreground text-xs">
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
				icon={<HugeiconsIcon className="size-4" icon={PuzzleIcon} />}
				reason={request.reason}
				title="Install a plugin?"
			/>
			{body}
			{footer}
		</section>
	);
});
