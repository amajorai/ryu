// apps/desktop/src/components/inference/ModelLaunchConfigSection.tsx
//
// Per-model "Engine / Hardware" launch-config editor, shown in the model detail
// panel. These flags (context size, GPU layers, MoE offload, chat template,
// speculative decoding, quantization) are passed to the engine when the model is
// loaded, so changes take effect the next time the model is served, not live.

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getEngineLaunchConfig,
	getEngineSamplingConfig,
	getModelLaunchConfig,
	type LaunchConfig,
	type SamplingConfig,
	saveEngineLaunchConfig,
	saveModelLaunchConfig,
} from "@/src/lib/api/inference.ts";
import {
	LaunchRefreshError,
	LaunchSaveActions,
} from "./ModelLaunchConfigSection-actions.tsx";
import {
	LaunchBatchingGroups,
	LaunchContextHardwareGroup,
} from "./ModelLaunchConfigSection-hardware.tsx";
import {
	LaunchLlamaCppGroups,
	LaunchSpeculativeGroup,
} from "./ModelLaunchConfigSection-llama.tsx";
import {
	buildOllamaProfile,
	OllamaProfileGroup,
	RawPassthroughGroup,
} from "./ModelLaunchConfigSection-profiles.tsx";
import {
	type BooleanKey,
	type Key,
	type LaunchFieldsApi,
	type LaunchNumberRule,
	LLAMA_SERVER_ENGINES,
	launchNumberError,
	launchSaveError,
	MODEL_SCOPE_NATIVE_ENGINES,
	type NumberKey,
	type StringKey,
} from "./ModelLaunchConfigSection-rules.ts";
import { LaunchVllmSglangGroup } from "./ModelLaunchConfigSection-vllm.tsx";
import { NativeLaunchOptions } from "./NativeLaunchOptions.tsx";

export function ModelLaunchConfigSection({
	modelId,
	engineId,
	launchAdapterSupported = true,
	subtitle,
	subtitleTitle,
}: {
	modelId?: string;
	/** Engine-wide defaults shown on the Engine details page. */
	engineId?: string;
	/** False when the runtime owns its process and Ryu cannot apply launch flags. */
	launchAdapterSupported?: boolean;
	/** Optional model name shown beside the header (used in the agent editor). */
	subtitle?: string;
	/** Optional hover text for the subtitle (e.g. the raw model id + quant info). */
	subtitleTitle?: string;
}) {
	const isEngineScope = Boolean(engineId);
	const configOwnerId = engineId ?? modelId ?? "";
	const configQueryKey = isEngineScope
		? ["engines", "launch-config", configOwnerId]
		: ["models", "launch-config", configOwnerId];
	const ownerLabel = isEngineScope ? "engine" : "model";
	const tl = useLiteralMessages();
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const { url } = target;
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [numberErrors, setNumberErrors] = useState<
		Partial<Record<Key, string>>
	>({});
	const [numberDrafts, setNumberDrafts] = useState<
		Partial<Record<Key, number>>
	>({});
	const previousOwnerId = useRef(`${ownerLabel}:${configOwnerId}`);

	const configQuery = useQuery({
		queryKey: [...configQueryKey, url],
		queryFn: () =>
			engineId
				? getEngineLaunchConfig(target, engineId)
				: getModelLaunchConfig(target, configOwnerId),
		enabled: open,
	});
	const ollamaSamplingQuery = useQuery({
		queryKey: ["engine", "sampling-config", url, "ollama"],
		queryFn: () => getEngineSamplingConfig(target, "ollama"),
		enabled: open && engineId === "ollama",
	});

	// Local editable draft, seeded from the loaded config.
	const [draft, setDraft] = useState<LaunchConfig>({});
	const [speculativeConfigText, setSpeculativeConfigText] = useState("");
	const [speculativeConfigError, setSpeculativeConfigError] = useState<
		string | null
	>(null);
	const [profileCopied, setProfileCopied] = useState(false);
	const [nativeValid, setNativeValid] = useState(true);
	const [profileCopyError, setProfileCopyError] = useState(false);
	useEffect(() => {
		if (configQuery.data) {
			setDraft(configQuery.data);
			setSpeculativeConfigText(
				configQuery.data.speculative_config
					? JSON.stringify(configQuery.data.speculative_config, null, 2)
					: ""
			);
			setSpeculativeConfigError(null);
		}
	}, [configQuery.data]);

	const saveMutation = useMutation({
		mutationFn: (config: LaunchConfig) =>
			engineId
				? saveEngineLaunchConfig(target, engineId, config)
				: saveModelLaunchConfig(target, configOwnerId, config),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: [...configQueryKey, url] })
			).catch(() => undefined);
		},
	});
	const resetSaveMutation = saveMutation.reset;
	useEffect(() => {
		const owner = `${ownerLabel}:${configOwnerId}`;
		if (previousOwnerId.current === owner) {
			return;
		}
		previousOwnerId.current = owner;
		setNumberErrors({});
		setNumberDrafts({});
		resetSaveMutation();
	}, [ownerLabel, configOwnerId, resetSaveMutation]);

	const set = <K extends Key>(key: K, v: LaunchConfig[K] | undefined): void => {
		setDraft((prev) => {
			const next: LaunchConfig = { ...prev };
			if (v === undefined) {
				delete next[key];
			} else {
				next[key] = v;
			}
			return next;
		});
	};
	const setSpeculativeConfig = (text: string) => {
		setSpeculativeConfigText(text);
		if (!text.trim()) {
			setSpeculativeConfigError(null);
			set("speculative_config", undefined);
			return;
		}
		try {
			const parsed = z.record(z.string(), z.json()).safeParse(JSON.parse(text));
			if (!parsed.success) {
				setSpeculativeConfigError("Speculative config must be a JSON object.");
				return;
			}
			setSpeculativeConfigError(null);
			set("speculative_config", parsed.data);
		} catch {
			setSpeculativeConfigError("Invalid JSON.");
		}
	};
	const num = (key: NumberKey) => numberDrafts[key] ?? draft[key] ?? undefined;
	const str = (key: StringKey) => draft[key] ?? undefined;
	const bool = (key: BooleanKey) => draft[key] ?? undefined;
	const setNumber = (
		key: Key,
		value: number | undefined,
		ruleOverride?: Partial<LaunchNumberRule>
	) => {
		if (value === undefined) {
			setNumberErrors((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
			setNumberDrafts((current) => {
				const next = { ...current };
				delete next[key];
				return next;
			});
			set(key, undefined);
			return;
		}
		const error = launchNumberError(key, value, ruleOverride, tl);
		if (error) {
			setNumberErrors((current) => ({ ...current, [key]: error }));
			setNumberDrafts((current) => ({ ...current, [key]: value }));
			return;
		}
		setNumberErrors((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
		setNumberDrafts((current) => {
			const next = { ...current };
			delete next[key];
			return next;
		});
		set(key, value);
	};
	const fields: LaunchFieldsApi = { bool, num, set, setNumber, str };
	const saveError = saveMutation.isError
		? launchSaveError(saveMutation.error)
		: null;
	const llamaCppEngine = !engineId || LLAMA_SERVER_ENGINES.has(engineId);
	const vllmEngine = !engineId || engineId === "vllm";
	const sglangEngine = !engineId || engineId === "sglang";
	const ollamaEngine = engineId === "ollama";
	const whisperEngine = engineId === "whispercpp";
	const mlxServeEngine = engineId === "mlx-serve";
	const meshLlmEngine = engineId === "mesh-llm";
	const manualRuntimeLaunch = isEngineScope && !launchAdapterSupported;
	const rawArgEngine =
		manualRuntimeLaunch ||
		llamaCppEngine ||
		vllmEngine ||
		sglangEngine ||
		engineId === "mlx" ||
		engineId === "mlx-vlm" ||
		engineId === "mlx-serve" ||
		engineId === "omlx" ||
		engineId === "apfel" ||
		engineId === "mesh-llm" ||
		engineId === "sdcpp" ||
		engineId === "outetts" ||
		engineId === "audiocpp" ||
		whisperEngine;
	const ollamaSampling: SamplingConfig = ollamaSamplingQuery.data ?? {};
	const ollamaProfile = buildOllamaProfile(draft, ollamaSampling);
	const copyOllamaProfile = async () => {
		try {
			await navigator.clipboard.writeText(ollamaProfile);
			setProfileCopied(true);
			setProfileCopyError(false);
		} catch {
			setProfileCopied(false);
			setProfileCopyError(true);
		}
	};
	const copyRuntimeArgs = async () => {
		try {
			await navigator.clipboard.writeText((draft.extra_args ?? []).join("\n"));
			setProfileCopied(true);
			setProfileCopyError(false);
		} catch {
			setProfileCopied(false);
			setProfileCopyError(true);
		}
	};

	return (
		<section
			aria-label={
				isEngineScope ? "Engine launch defaults" : "Engine and hardware"
			}
			className="flex flex-col gap-2"
		>
			<Collapsible
				className="flex flex-col gap-2"
				onOpenChange={setOpen}
				open={open}
			>
				<CollapsibleTrigger className="group/disclosure flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left outline-none transition-colors duration-150 hover:bg-muted hover:duration-0 focus-visible:ring-2 focus-visible:ring-ring">
					<span className="font-semibold text-sm">
						{isEngineScope ? "Engine launch settings" : "Engine / Hardware"}
					</span>
					{subtitle ? (
						<span
							className="truncate text-muted-foreground text-xs"
							title={subtitleTitle}
						>
							{subtitle}
						</span>
					) : null}
					<span className="ml-auto text-muted-foreground">
						<HugeiconsIcon
							className="size-4 transition-transform duration-(--duration-fast) ease-move group-data-[panel-open]/disclosure:rotate-90"
							icon={ArrowRight01Icon}
						/>
					</span>
				</CollapsibleTrigger>

				<CollapsibleContent>
					{open ? (
						<SettingsSection
							caption={
								// The manual-runtime warning stays whole: it says Ryu cannot
								// apply these arguments, which is the point of the note.
								manualRuntimeLaunch ? (
									"This is a saved copy only. Paste the arguments into the external runtime; Ryu cannot apply them to that process."
								) : (
									<CaptionInfo
										detail={
											isEngineScope
												? "Changes apply on the next engine start. Leave a field blank to keep the engine default."
												: "Changes apply the next time the model is loaded. Leave a field blank to use the engine default."
										}
									>
										{isEngineScope
											? "Launch defaults for every model served by this engine."
											: "Launch flags for this model."}
									</CaptionInfo>
								)
							}
						>
							<SettingsCard className="flex flex-col gap-6">
								{Object.entries(numberErrors).map(([key, message]) => (
									<p
										className="text-status-destructive text-xs"
										key={key}
										role="alert"
									>
										{message}
									</p>
								))}
								{configQuery.isLoading && !configQuery.data ? (
									<SkeletonRows label="Loading config…" spacing="comfortable" />
								) : configQuery.isError && !configQuery.data ? (
									<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
										<p className="text-status-destructive text-xs" role="alert">
											{tl(
												"Could not load {ownerLabel} launch config: {error}",
												{
													error: launchSaveError(configQuery.error),
													ownerLabel,
												}
											)}
										</p>
										<Button
											disabled={configQuery.isFetching}
											loading={configQuery.isFetching}
											onClick={() => void configQuery.refetch()}
											size="sm"
											variant="outline"
										>
											{tl("Retry {ownerLabel} config", { ownerLabel })}
										</Button>
									</div>
								) : (
									<>
										{configQuery.isError ? (
											<LaunchRefreshError
												error={launchSaveError(configQuery.error)}
												isFetching={configQuery.isFetching}
												onRetry={() => void configQuery.refetch()}
												ownerLabel={ownerLabel}
											/>
										) : null}
										<LaunchContextHardwareGroup
											fields={fields}
											llamaCppEngine={llamaCppEngine}
											meshLlmEngine={meshLlmEngine}
											mlxServeEngine={mlxServeEngine}
											ollamaEngine={ollamaEngine}
											sglangEngine={sglangEngine}
											vllmEngine={vllmEngine}
											whisperEngine={whisperEngine}
										/>
										<OllamaProfileGroup
											copyOllamaProfile={copyOllamaProfile}
											ollamaEngine={ollamaEngine}
											ollamaProfile={ollamaProfile}
											profileCopied={profileCopied}
											profileCopyError={profileCopyError}
										/>
										<LaunchBatchingGroups
											fields={fields}
											llamaCppEngine={llamaCppEngine}
										/>
										<LaunchLlamaCppGroups
											configOwnerId={configOwnerId}
											fields={fields}
											llamaCppEngine={llamaCppEngine}
										/>
										<LaunchSpeculativeGroup
											fields={fields}
											llamaCppEngine={llamaCppEngine}
											meshLlmEngine={meshLlmEngine}
											sglangEngine={sglangEngine}
										/>
										<LaunchVllmSglangGroup
											configOwnerId={configOwnerId}
											fields={fields}
											setSpeculativeConfig={setSpeculativeConfig}
											sglangEngine={sglangEngine}
											speculativeConfigError={speculativeConfigError}
											speculativeConfigText={speculativeConfigText}
											vllmEngine={vllmEngine}
										/>

										{manualRuntimeLaunch ? null : (
											<NativeLaunchOptions
												engineChoices={
													isEngineScope ? undefined : MODEL_SCOPE_NATIVE_ENGINES
												}
												engineId={engineId ?? "llamacpp"}
												key={`${ownerLabel}:${configOwnerId}`}
												onChange={(native) => set("native", native)}
												onValidityChange={setNativeValid}
												value={draft.native}
											/>
										)}

										<RawPassthroughGroup
											copyRuntimeArgs={copyRuntimeArgs}
											draft={draft}
											engineId={engineId}
											fields={fields}
											manualRuntimeLaunch={manualRuntimeLaunch}
											profileCopied={profileCopied}
											profileCopyError={profileCopyError}
											rawArgEngine={rawArgEngine}
										/>

										<LaunchSaveActions
											disabled={
												saveMutation.isPending ||
												Object.keys(numberErrors).length > 0 ||
												Boolean(speculativeConfigError) ||
												!nativeValid ||
												configQuery.isError ||
												!configQuery.data
											}
											onSave={() => saveMutation.mutate(draft)}
											ownerLabel={ownerLabel}
											saved={saveMutation.isSuccess}
											saveError={saveError}
											saving={saveMutation.isPending}
										/>
									</>
								)}
							</SettingsCard>
						</SettingsSection>
					) : null}
				</CollapsibleContent>
			</Collapsible>
		</section>
	);
}

/** Global launch defaults, hosted on the selected Engine detail page. */
export function EngineLaunchConfigSection({
	engineId,
	launchAdapterSupported = true,
}: {
	engineId: string;
	launchAdapterSupported?: boolean;
}) {
	return (
		<ModelLaunchConfigSection
			engineId={engineId}
			launchAdapterSupported={launchAdapterSupported}
		/>
	);
}
