import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	clearPluginSecret,
	listPluginSecrets,
	setPluginSecret,
} from "@/src/lib/api/plugin-secrets.ts";
import {
	getShadowComputerUseConfigStrict,
	type ShadowComputerUseConfigUpdate,
	setShadowComputerUseConfig,
} from "@/src/lib/api/shadow.ts";
import { startSidecar, stopSidecar } from "@/src/lib/services-api.ts";
import {
	COMPUTER_USE_DEFAULTS,
	JEV_SECRET_KEY,
	plannerOptionValue,
	SHADOW_PLUGIN_ID,
} from "./ShadowSettings-constants.ts";

/**
 * Computer-use planner state for the Shadow settings tab: the saved planner
 * config, the encrypted Jev credential, and their load/save actions.
 */
export function useShadowComputerUseState(
	localTarget: ApiTarget,
	refreshShadow: () => Promise<boolean>
) {
	const tl = useLiteralMessages();
	const { computer_use_planners: computerUsePlanners } =
		usePluginContributions(localTarget);
	const [computerUse, setComputerUse] = useState<ShadowComputerUseConfigUpdate>(
		() => ({
			...COMPUTER_USE_DEFAULTS,
			layaUrl: `${localTarget.url}/api/ext/@ryu/laya/predict`,
		})
	);
	const [computerUseLoaded, setComputerUseLoaded] = useState(false);
	const [computerUseLoadFailed, setComputerUseLoadFailed] = useState(false);
	const [jevSecretLoaded, setJevSecretLoaded] = useState(false);
	const [jevSecretLoadFailed, setJevSecretLoadFailed] = useState(false);
	const computerUseLoadEpoch = useRef(0);
	const computerUseWriteInFlight = useRef(false);
	const [jevApiKeyConfigured, setJevApiKeyConfigured] = useState(false);
	const [jevSecretSet, setJevSecretSet] = useState(false);
	const [jevSecretShadowed, setJevSecretShadowed] = useState(false);
	const [jevKeyDraft, setJevKeyDraft] = useState("");
	const [computerUseBusy, setComputerUseBusy] = useState(false);
	const [computerUseError, setComputerUseError] = useState<string | null>(null);
	const [computerUseReadError, setComputerUseReadError] = useState<
		string | null
	>(null);
	const [computerUseNotice, setComputerUseNotice] = useState<string | null>(
		null
	);
	const selectedLocalPlanner = computerUsePlanners.find(
		(planner) =>
			planner.plugin === computerUse.localPluginId &&
			planner.model_id === computerUse.localModelId
	);
	const localPlannerSelectValue = selectedLocalPlanner
		? plannerOptionValue(selectedLocalPlanner.plugin, selectedLocalPlanner.id)
		: computerUse.localPluginId && computerUse.localModelId
			? plannerOptionValue(computerUse.localPluginId, computerUse.localModelId)
			: "";
	// One list feeds both the options and the closed trigger's label; without
	// `items` the trigger would show the internal `plugin:model` value.
	const localPlannerItems = computerUsePlanners.map((planner) => ({
		value: plannerOptionValue(planner.plugin, planner.id),
		label: `${planner.label} · ${planner.plugin}`,
	}));
	if (!selectedLocalPlanner && localPlannerSelectValue) {
		localPlannerItems.push({
			value: localPlannerSelectValue,
			label: tl("Unavailable model · {localPluginId}", {
				localPluginId: computerUse.localPluginId,
			}),
		});
	}

	const loadComputerUse = useCallback(async () => {
		const epoch = ++computerUseLoadEpoch.current;
		setComputerUseLoaded(false);
		setComputerUseLoadFailed(false);
		setJevSecretLoaded(false);
		setJevSecretLoadFailed(false);
		setComputerUseReadError(null);
		setComputerUseNotice(null);
		const reportReadFailure = (error: unknown): never => {
			if (computerUseLoadEpoch.current === epoch) {
				setComputerUseLoadFailed(true);
				setComputerUseReadError(
					error instanceof Error
						? error.message
						: "Could not load computer-use settings."
				);
			}
			throw error;
		};
		const results = await Promise.allSettled([
			getShadowComputerUseConfigStrict()
				.then((config) => {
					if (computerUseLoadEpoch.current !== epoch) {
						return;
					}
					const {
						applied: _applied,
						jevApiKeyConfigured: _configured,
						...editable
					} = config;
					setComputerUse(
						editable.planner === "laya"
							? {
									...editable,
									planner: "local",
									localPluginId: editable.localPluginId || "@ryu/laya",
									localModelId: editable.localModelId || "router",
								}
							: editable
					);
					setJevApiKeyConfigured(config.jevApiKeyConfigured);
					setComputerUseLoaded(true);
				})
				.catch(reportReadFailure),
			listPluginSecrets(localTarget, SHADOW_PLUGIN_ID)
				.then((secrets) => {
					if (computerUseLoadEpoch.current !== epoch) {
						return;
					}
					const secret = secrets.find((entry) => entry.key === JEV_SECRET_KEY);
					setJevSecretSet(secret?.set ?? false);
					setJevSecretShadowed(secret?.shadowed_by_env ?? false);
					setJevSecretLoaded(true);
				})
				.catch((error) => {
					if (computerUseLoadEpoch.current === epoch) {
						setJevSecretLoadFailed(true);
					}
					return reportReadFailure(error);
				}),
		]);
		if (computerUseLoadEpoch.current !== epoch) {
			return;
		}
		setJevSecretLoadFailed(results[1].status === "rejected");
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length > 0) {
			setComputerUseLoadFailed(true);
			setComputerUseReadError(
				failures
					.map((failure) =>
						failure.reason instanceof Error
							? failure.reason.message
							: "Could not load computer-use settings."
					)
					.join("; ")
			);
		}
	}, [localTarget]);

	useEffect(() => {
		void loadComputerUse();
		return () => {
			computerUseLoadEpoch.current += 1;
		};
	}, [loadComputerUse]);

	const saveComputerUse = async () => {
		if (computerUseWriteInFlight.current || !computerUseLoaded) {
			return;
		}
		computerUseWriteInFlight.current = true;
		setComputerUseBusy(true);
		setComputerUseError(null);
		setComputerUseNotice(null);
		try {
			const saved = await setShadowComputerUseConfig(computerUse);
			const {
				applied: _applied,
				jevApiKeyConfigured: _configured,
				...editable
			} = saved;
			setComputerUse(editable);
			setComputerUseNotice(
				saved.applied
					? "Computer-use settings saved and applied."
					: "Computer-use settings saved; they will apply when Shadow starts."
			);
		} catch (error) {
			setComputerUseError(
				error instanceof Error
					? error.message
					: "Could not save computer-use settings."
			);
		} finally {
			computerUseWriteInFlight.current = false;
			setComputerUseBusy(false);
		}
	};

	const restartShadowForCredential = async () => {
		const reachable = await refreshShadow();
		if (reachable) {
			await stopSidecar(
				localTarget.url,
				localTarget.token,
				"shadow",
				localTarget.userJwt ?? null
			);
			await startSidecar(
				localTarget.url,
				localTarget.token,
				"shadow",
				localTarget.userJwt ?? null
			);
			await refreshShadow();
			return true;
		}
		return false;
	};

	const saveJevKey = async () => {
		if (computerUseWriteInFlight.current || !jevSecretLoaded) {
			return;
		}
		if (!jevKeyDraft.trim()) {
			setComputerUseError("Paste a Jev API key before saving.");
			return;
		}
		computerUseWriteInFlight.current = true;
		setComputerUseBusy(true);
		setComputerUseError(null);
		setComputerUseNotice(null);
		try {
			await setPluginSecret(
				localTarget,
				SHADOW_PLUGIN_ID,
				JEV_SECRET_KEY,
				jevKeyDraft.trim()
			);
			const secret = (
				await listPluginSecrets(localTarget, SHADOW_PLUGIN_ID)
			).find((entry) => entry.key === JEV_SECRET_KEY);
			setJevKeyDraft("");
			setJevSecretSet(secret?.set ?? true);
			setJevSecretShadowed(secret?.shadowed_by_env ?? false);
			setJevApiKeyConfigured(true);
			const restarted = await restartShadowForCredential();
			setComputerUseNotice(
				restarted
					? "Jev key saved encrypted. Shadow restarted to load it."
					: "Jev key saved encrypted. Shadow will load it when it next starts."
			);
		} catch (error) {
			setComputerUseError(
				error instanceof Error ? error.message : "Could not save the Jev key."
			);
		} finally {
			computerUseWriteInFlight.current = false;
			setComputerUseBusy(false);
		}
	};

	const clearJevKey = async () => {
		if (computerUseWriteInFlight.current || !jevSecretLoaded) {
			return;
		}
		computerUseWriteInFlight.current = true;
		setComputerUseBusy(true);
		setComputerUseError(null);
		setComputerUseNotice(null);
		try {
			await clearPluginSecret(localTarget, SHADOW_PLUGIN_ID, JEV_SECRET_KEY);
			const secret = (
				await listPluginSecrets(localTarget, SHADOW_PLUGIN_ID)
			).find((entry) => entry.key === JEV_SECRET_KEY);
			setJevSecretSet(secret?.set ?? false);
			setJevSecretShadowed(secret?.shadowed_by_env ?? false);
			setJevApiKeyConfigured(Boolean(secret?.shadowed_by_env));
			const restarted = await restartShadowForCredential();
			setComputerUseNotice(
				secret?.shadowed_by_env
					? "Stored Jev key cleared. The process environment still provides a key."
					: restarted
						? "Stored Jev key cleared. Shadow restarted."
						: "Stored Jev key cleared. The change applies when Shadow next starts."
			);
		} catch (error) {
			setComputerUseError(
				error instanceof Error ? error.message : "Could not clear the Jev key."
			);
		} finally {
			computerUseWriteInFlight.current = false;
			setComputerUseBusy(false);
		}
	};

	return {
		clearJevKey,
		computerUse,
		computerUseBusy,
		computerUseError,
		computerUseLoaded,
		computerUseLoadFailed,
		computerUseNotice,
		computerUsePlanners,
		computerUseReadError,
		computerUseWriteInFlight,
		jevApiKeyConfigured,
		jevKeyDraft,
		jevSecretLoaded,
		jevSecretLoadFailed,
		jevSecretSet,
		jevSecretShadowed,
		loadComputerUse,
		localPlannerItems,
		localPlannerSelectValue,
		saveComputerUse,
		saveJevKey,
		selectedLocalPlanner,
		setComputerUse,
		setJevKeyDraft,
	};
}

export type ShadowComputerUseState = ReturnType<
	typeof useShadowComputerUseState
>;
