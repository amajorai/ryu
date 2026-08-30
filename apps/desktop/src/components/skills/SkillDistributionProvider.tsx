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

export interface SkillDistributionFlow {
	distributeInstalledSkill(
		skillId: string
	): Promise<SkillDistributionResult | null>;
	installCatalogSkill(input: {
		id: string;
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
			text: `Installed in Ryu. Added to ${successful.length} ${successful.length === 1 ? "agent" : "agents"}.`,
		});
	}
	for (const target of result.targets) {
		const name = targetDisplayName(target.targetId, snapshot);
		if (target.status === "conflict") {
			notices.push({
				kind: "error",
				text: `${name} has a different copy. Ryu left it unchanged.`,
			});
		} else if (target.status === "failed") {
			notices.push({
				kind: "error",
				text: `Installed in Ryu. ${name} could not be updated.`,
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
	if (!value) {
		throw new Error(
			"useSkillDistributionFlow must be used within SkillDistributionProvider"
		);
	}
	return value;
}

export function SkillDistributionProvider({
	children,
	services = productionServices,
}: SkillDistributionProviderProps) {
	const getActiveNode = useActiveNodeGetter();
	const [dialog, setDialog] = useState<DialogState | null>(null);
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
			const notices = distributionNotices(result, snapshot);
			setAnnouncements(notices.map((notice) => notice.text));
			for (const notice of notices) {
				if (notice.kind === "error") {
					sileo.error({ title: notice.text });
				} else {
					sileo.success({ title: notice.text });
				}
			}
		},
		[]
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
		};
	}, []);

	const installCatalogSkill = useCallback<
		SkillDistributionFlow["installCatalogSkill"]
	>(
		async (input) => {
			const { target: explicitTarget, ...catalogInput } = input;
			try {
				const result = await services.install(
					explicitTarget ?? activeTarget(),
					catalogInput,
					{
						promptForTargets: true,
					}
				);
				if (result.distribution) {
					announce(result.distribution);
				}
				return result;
			} catch (error) {
				if (!(error instanceof SkillTargetsRequiredError)) {
					throw error;
				}
			}

			// The node may have changed while the precondition request was in flight.
			// Open and retry against one fresh target so the dialog never describes a
			// different computer from the one receiving the explicit selection.
			const target = explicitTarget ?? activeTarget();
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
		[activeTarget, announce, requestChoice, services]
	);

	const distributeInstalledSkill = useCallback<
		SkillDistributionFlow["distributeInstalledSkill"]
	>(
		async (skillId) => {
			const target = activeTarget();
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
		() => ({ distributeInstalledSkill, installCatalogSkill }),
		[distributeInstalledSkill, installCatalogSkill]
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
		</SkillDistributionContext.Provider>
	);
}
