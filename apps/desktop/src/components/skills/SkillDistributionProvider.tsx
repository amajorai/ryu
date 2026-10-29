import { promptEditCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { sileo } from "sileo";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	distributeSkill,
	fetchSkillTargets,
	installSkill,
	type SkillDistributionResult,
	type SkillInstallOptions,
	type SkillInstallResult,
	SkillTargetsRequiredError,
	type SkillTargetsSnapshot,
} from "@/src/lib/api/skills.ts";
import {
	type SkillTargetChoice,
	SkillTargetDialog,
} from "./SkillTargetDialog.tsx";
import { skillDisplayName, skillSetChangeLabels } from "./skill-set-change.ts";

export interface SkillDistributionFlow {
	/**
	 * Ask before a change to the node's enabled skill set (enable, disable,
	 * install). Core folds that set into the system prompt of every thread that
	 * loads skills, so the change resets each one's prompt cache once. Resolves
	 * true at once when no skill is named, false when the user cancels.
	 */
	confirmSkillSetChange(skillNames: readonly string[]): Promise<boolean>;
	distributeInstalledSkill(
		skillId: string,
		target?: ApiTarget
	): Promise<SkillDistributionResult | null>;
	/** Install a catalog skill after the prompt-cache confirmation; null when cancelled. */
	installCatalogSkill(input: {
		id: string;
		/** Display name for the confirmation; the id's last segment otherwise. */
		name?: string;
		/** The caller already asked with `confirmSkillSetChange`; do not ask again. */
		promptCacheConfirmed?: boolean;
		source?: string;
		target?: ApiTarget;
	}): Promise<SkillInstallResult | null>;
}

export interface SkillDistributionServices {
	distribute(
		target: ApiTarget,
		skillId: string,
		choice: SkillTargetChoice
	): Promise<SkillDistributionResult>;
	fetchTargets(target: ApiTarget): Promise<SkillTargetsSnapshot>;
	install(
		target: ApiTarget,
		input: { id: string; source?: string },
		options: SkillInstallOptions
	): Promise<SkillInstallResult>;
}

export interface SkillDistributionProviderProps {
	children: ReactNode;
	services?: SkillDistributionServices;
}

const productionServices: SkillDistributionServices = {
	distribute: distributeSkill,
	fetchTargets: fetchSkillTargets,
	install: (target, input, options) =>
		installSkill(target, input.id, input.source, options),
};

interface DialogState {
	actionLabel: "Export" | "Install";
	initialChoice: SkillTargetChoice;
	snapshot: SkillTargetsSnapshot;
}

interface PendingSelection {
	resolve: (choice: SkillTargetChoice | null) => void;
}

type TargetFetchOutcome =
	| { kind: "cancelled" }
	| { kind: "snapshot"; snapshot: SkillTargetsSnapshot };

interface DistributionNotice {
	kind: "error" | "success";
	text: string;
}

function targetDisplayName(targetId: string, snapshot?: SkillTargetsSnapshot) {
	const known = snapshot?.targets.find(
		(target) => target.id === targetId
	)?.name;
	if (known) {
		return known;
	}
	return targetId
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
}

export function distributionNotices(
	result: SkillDistributionResult,
	tl: LiteralMessage,
	snapshot?: SkillTargetsSnapshot
): DistributionNotice[] {
	if (result.targets.length === 0) {
		return [
			{
				kind: "success",
				text: "No agents selected. This skill remains available in Ryu only.",
			},
		];
	}

	const successful = result.targets.filter(
		(target) => target.status === "copied" || target.status === "current"
	);
	const notices: DistributionNotice[] = [];
	if (successful.length > 0) {
		notices.push({
			kind: "success",
			text: tl(
				"Installed in Ryu. Added to {agentCount, plural, one {# agent} other {# agents}}.",
				{ agentCount: successful.length }
			),
		});
	}
	for (const target of result.targets) {
		const name = targetDisplayName(target.targetId, snapshot);
		if (target.status === "conflict") {
			notices.push({
				kind: "error",
				text: tl("{name} has a different copy. Ryu left it unchanged.", {
					name,
				}),
			});
		} else if (target.status === "failed") {
			notices.push({
				kind: "error",
				text: tl("Installed in Ryu. {name} could not be updated.", { name }),
			});
		}
	}
	return notices;
}

const SkillDistributionContext = createContext<SkillDistributionFlow | null>(
	null
);

export function useSkillDistributionFlow(): SkillDistributionFlow {
	const value = useContext(SkillDistributionContext);
	const getActiveNode = useActiveNodeGetter();
	const callerFlow = useMemo<SkillDistributionFlow | null>(() => {
		if (!value) {
			return null;
		}
		const callerTarget = (): ApiTarget => {
			const node = getActiveNode();
			return {
				url: node.url,
				token: node.token ?? null,
				userJwt: node.userJwt ?? null,
			};
		};
		return {
			confirmSkillSetChange: value.confirmSkillSetChange,
			installCatalogSkill: (input) =>
				value.installCatalogSkill({
					...input,
					target: input.target ?? callerTarget(),
				}),
			distributeInstalledSkill: (skillId, target) =>
				value.distributeInstalledSkill(skillId, target ?? callerTarget()),
		};
	}, [value, getActiveNode]);
	if (!callerFlow) {
		throw new Error(
			"useSkillDistributionFlow must be used within SkillDistributionProvider"
		);
	}
	return callerFlow;
}

export function SkillDistributionProvider({
	children,
	services = productionServices,
}: SkillDistributionProviderProps) {
	const getActiveNode = useActiveNodeGetter();
	const tl = useLiteralMessages();
	const [dialog, setDialog] = useState<DialogState | null>(null);
	const [cacheConfirmation, setCacheConfirmation] =
		useState<PromptCacheConfirmation | null>(null);
	const pendingCacheConfirmRef = useRef<((apply: boolean) => void) | null>(
		null
	);
	const [announcements, setAnnouncements] = useState<string[]>([]);
	const pendingSelectionRef = useRef<PendingSelection | null>(null);
	const openingRef = useRef(false);
	const mountedRef = useRef(true);
	const cancelTargetFetchesRef = useRef(new Set<() => void>());

	const activeTarget = useCallback((): ApiTarget => {
		const node = getActiveNode();
		return {
			url: node.url,
			token: node.token ?? null,
			userJwt: node.userJwt ?? null,
		};
	}, [getActiveNode]);

	const announce = useCallback(
		(result: SkillDistributionResult, snapshot?: SkillTargetsSnapshot) => {
			const notices = distributionNotices(result, tl, snapshot);
			setAnnouncements(notices.map((notice) => notice.text));
			for (const notice of notices) {
				if (notice.kind === "error") {
					sileo.error({ title: notice.text });
				} else {
					sileo.success({ title: notice.text });
				}
			}
		},
		[tl]
	);

	const requestChoice = useCallback(
		async (
			target: ApiTarget,
			actionLabel: DialogState["actionLabel"]
		): Promise<{
			choice: SkillTargetChoice;
			snapshot: SkillTargetsSnapshot;
		} | null> => {
			if (openingRef.current || pendingSelectionRef.current) {
				throw new Error("A skill target selection is already open.");
			}
			openingRef.current = true;
			let cancelTargetFetch: () => void = () => undefined;
			const cancelled = new Promise<TargetFetchOutcome>((resolve) => {
				cancelTargetFetch = () => resolve({ kind: "cancelled" });
			});
			cancelTargetFetchesRef.current.add(cancelTargetFetch);
			try {
				const outcome = await Promise.race([
					Promise.resolve()
						.then(() => services.fetchTargets(target))
						.then(
							(snapshot): TargetFetchOutcome => ({ kind: "snapshot", snapshot })
						),
					cancelled,
				]);
				if (outcome.kind === "cancelled" || !mountedRef.current) {
					return null;
				}
				const { snapshot } = outcome;
				const choice = await new Promise<SkillTargetChoice | null>(
					(resolve) => {
						pendingSelectionRef.current = { resolve };
						setDialog({
							actionLabel,
							initialChoice: {
								remember: snapshot.preferences.configured,
								targetIds: snapshot.preferences.targetIds,
							},
							snapshot,
						});
					}
				);
				return choice ? { choice, snapshot } : null;
			} finally {
				cancelTargetFetchesRef.current.delete(cancelTargetFetch);
				openingRef.current = false;
			}
		},
		[services]
	);

	const closeDialog = useCallback((choice: SkillTargetChoice | null) => {
		const pending = pendingSelectionRef.current;
		pendingSelectionRef.current = null;
		setDialog(null);
		pending?.resolve(choice);
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			for (const cancelTargetFetch of cancelTargetFetchesRef.current) {
				cancelTargetFetch();
			}
			cancelTargetFetchesRef.current.clear();
			pendingSelectionRef.current?.resolve(null);
			pendingSelectionRef.current = null;
			pendingCacheConfirmRef.current?.(false);
			pendingCacheConfirmRef.current = null;
		};
	}, []);

	const confirmSkillSetChange = useCallback<
		SkillDistributionFlow["confirmSkillSetChange"]
	>((skillNames) => {
		const warning = promptEditCacheWarning(
			skillSetChangeLabels(skillNames),
			"skill-threads"
		);
		if (!warning) {
			return Promise.resolve(true);
		}
		// The dialog is modal, so a second request can only come from code; it
		// must not replace the question the user is answering.
		if (pendingCacheConfirmRef.current || !mountedRef.current) {
			return Promise.resolve(false);
		}
		return new Promise<boolean>((resolve) => {
			pendingCacheConfirmRef.current = resolve;
			setCacheConfirmation(warning);
		});
	}, []);

	const closeCacheConfirmation = useCallback((apply: boolean) => {
		const pending = pendingCacheConfirmRef.current;
		pendingCacheConfirmRef.current = null;
		setCacheConfirmation(null);
		pending?.(apply);
	}, []);

	const installCatalogSkill = useCallback<
		SkillDistributionFlow["installCatalogSkill"]
	>(
		async (input) => {
			const {
				name,
				promptCacheConfirmed,
				target: explicitTarget,
				...catalogInput
			} = input;
			const target = explicitTarget ?? activeTarget();
			// Installing activates the skill, which changes the skills block of
			// every thread that loads skills.
			const confirmed =
				promptCacheConfirmed === true ||
				(await confirmSkillSetChange([
					skillDisplayName(catalogInput.id, name),
				]));
			if (!confirmed) {
				return null;
			}
			try {
				const result = await services.install(target, catalogInput, {
					promptForTargets: true,
				});
				if (result.distribution) {
					announce(result.distribution);
				}
				return result;
			} catch (error) {
				if (!(error instanceof SkillTargetsRequiredError)) {
					throw error;
				}
			}

			// Keep the invoking node and credentials through the precondition,
			// selection dialog, and retry even if the active tab changes.
			const selected = await requestChoice(target, "Install");
			if (!selected) {
				return null;
			}
			const result = await services.install(target, catalogInput, {
				promptForTargets: true,
				targetIds: selected.choice.targetIds,
				rememberTargetIds: selected.choice.remember,
			});
			if (result.distribution) {
				announce(result.distribution, selected.snapshot);
			}
			return result;
		},
		[activeTarget, announce, confirmSkillSetChange, requestChoice, services]
	);

	const distributeInstalledSkill = useCallback<
		SkillDistributionFlow["distributeInstalledSkill"]
	>(
		async (skillId, explicitTarget) => {
			const target = explicitTarget ?? activeTarget();
			const selected = await requestChoice(target, "Export");
			if (!selected) {
				return null;
			}
			const result = await services.distribute(
				target,
				skillId,
				selected.choice
			);
			announce(result, selected.snapshot);
			return result;
		},
		[activeTarget, announce, requestChoice, services]
	);

	const flow = useMemo<SkillDistributionFlow>(
		() => ({
			confirmSkillSetChange,
			distributeInstalledSkill,
			installCatalogSkill,
		}),
		[confirmSkillSetChange, distributeInstalledSkill, installCatalogSkill]
	);

	return (
		<SkillDistributionContext.Provider value={flow}>
			{children}
			<div
				aria-atomic="true"
				aria-live="polite"
				className="sr-only"
				role="status"
			>
				{announcements.join(" ")}
			</div>
			<SkillTargetDialog
				actionLabel={dialog?.actionLabel ?? "Install"}
				initialChoice={
					dialog?.initialChoice ?? { remember: false, targetIds: [] }
				}
				onCancel={() => closeDialog(null)}
				onConfirm={(choice) => closeDialog(choice)}
				open={dialog !== null}
				targets={dialog?.snapshot.targets ?? []}
			/>
			<PromptCacheConfirmDialog
				confirmation={cacheConfirmation}
				onApply={() => closeCacheConfirmation(true)}
				onCancel={() => closeCacheConfirmation(false)}
			/>
		</SkillDistributionContext.Provider>
	);
}
