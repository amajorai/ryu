// apps/desktop/src/components/settings/ModelParametersSettings.tsx
//
// Per-model parameters for local AND cloud models, plus node-level presets.
//
// Pick a local engine model or a cloud provider model, then tune exactly the
// sampling fields that model receives: Core reports the list per local engine
// or per cloud provider (`/api/inference/sampling-fields`), so llama.cpp shows
// every sampler while Anthropic shows Temperature / Top P / Top K. Local models
// also get their engine-launch settings (context size, GPU layers, ...).
//
// Presets are named parameter bundles stored once on the active node
// (`/api/inference/presets`). Applying one saves its values to the selected
// model, keeping only the fields that model accepts, so one preset serves both
// a llama.cpp model and a cloud model.

import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AgentModelPickerField } from "@/components/agent-elements/input/agent-model-picker-field.tsx";
import { AdvancedInferenceSection } from "@/src/components/inference/AdvancedInferenceSection.tsx";
import { ModelLaunchConfigSection } from "@/src/components/inference/ModelLaunchConfigSection.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getModelSamplingConfig,
	getSamplingFieldSupport,
	type SamplingConfig,
	saveModelSamplingConfig,
} from "@/src/lib/api/inference.ts";
import { LocalModelSelect } from "./ModelParametersSettings-local-model-select.tsx";
import {
	errorMessage,
	type ModelKind,
	type SelectedModel,
} from "./ModelParametersSettings-model-selection.ts";
import { PresetBar } from "./ModelParametersSettings-preset-bar.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export {
	LOCAL_ENGINE_IDS,
	type ModelKind,
	type SelectedModel,
} from "./ModelParametersSettings-model-selection.ts";
export {
	presetFitsKind,
	presetsQueryKey,
} from "./ModelParametersSettings-preset-bar.tsx";

export function ModelParameterEditor({
	model,
	target,
}: {
	model: SelectedModel;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const samplingKey = ["models", "sampling-config", target.url, model.id];
	const supportQuery = useQuery({
		queryKey: [
			"inference",
			"sampling-fields",
			target.url,
			model.engine ?? "",
			model.provider ?? "",
		],
		queryFn: () =>
			getSamplingFieldSupport(target, {
				engine: model.engine,
				provider: model.provider,
			}),
		staleTime: 5 * 60 * 1000,
	});
	const samplingQuery = useQuery({
		queryKey: samplingKey,
		queryFn: () => getModelSamplingConfig(target, model.id),
	});
	const fields = useMemo(
		() => new Set(supportQuery.data?.fields ?? []),
		[supportQuery.data]
	);
	// Bumped when a preset replaces the saved values so the form remounts with
	// them (its JSON editors keep internal text state).
	const [revision, setRevision] = useState(0);
	const [draft, setDraft] = useState<SamplingConfig | null>(null);
	const value = draft ?? samplingQuery.data ?? {};

	const save = useMutation({
		mutationFn: (config: SamplingConfig) =>
			saveModelSamplingConfig(target, model.id, config),
		onSuccess: async () => {
			await queryClient
				.invalidateQueries({ queryKey: samplingKey })
				.catch(() => undefined);
		},
	});

	if (supportQuery.isLoading || samplingQuery.isLoading) {
		return <SkeletonRows label="Loading model parameters…" rows={2} />;
	}
	if (supportQuery.isError || samplingQuery.isError) {
		return (
			<div
				className="flex min-h-12 items-center justify-between gap-6 py-3"
				role="alert"
			>
				<p className="text-sm">Could not load this model's parameters.</p>
				<Button
					onClick={() => {
						supportQuery.refetch().catch(() => undefined);
						samplingQuery.refetch().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<PresetBar
				draft={value}
				fields={fields}
				model={model}
				onApplied={(sampling) => {
					queryClient.setQueryData(samplingKey, sampling);
					setDraft(null);
					save.reset();
					setRevision((current) => current + 1);
				}}
				target={target}
			/>
			<AdvancedInferenceSection
				defaultOpen
				engineId={model.engine}
				key={`${model.id}:${revision}`}
				localEngine={model.kind === "local"}
				onChange={setDraft}
				onSave={() => save.mutate(value)}
				saved={save.isSuccess && draft === null}
				saveError={
					save.isError ? errorMessage(save.error, "Could not save") : null
				}
				saving={save.isPending}
				scope="model"
				supportedFields={fields}
				value={value}
			/>
			{model.kind === "local" ? (
				<ModelLaunchConfigSection
					key={model.id}
					modelId={model.id}
					subtitle={model.label}
				/>
			) : (
				<p className="text-detail text-muted-foreground">
					Cloud models have no launch settings. External agents use their own.
				</p>
			)}
		</div>
	);
}

export function ModelParametersSettings() {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const [kind, setKind] = useState<ModelKind>("local");
	const [selected, setSelected] = useState<SelectedModel | null>(null);
	const current = selected?.kind === kind ? selected : null;

	return (
		<SettingsSection
			caption="Tune generation for any model on this node and save presets. Agents and requests can still override."
			title="Model parameters"
		>
			<SettingsCard className="flex flex-col gap-3 py-3">
				<ToggleGroup
					appearance="segmented"
					aria-label="Model type"
					onValueChange={(values: string[]) => {
						const next = values[0];
						if (next === "local" || next === "cloud") {
							setKind(next);
						}
					}}
					spacing={0}
					value={[kind]}
					variant="default"
				>
					<ToggleGroupItem density="segmented" value="local">
						Local models
					</ToggleGroupItem>
					<ToggleGroupItem density="segmented" value="cloud">
						Cloud models
					</ToggleGroupItem>
				</ToggleGroup>
				{kind === "local" ? (
					<LocalModelSelect onSelect={setSelected} value={current} />
				) : (
					<AgentModelPickerField
						ariaLabel="Cloud model"
						mode="model"
						onChange={(id) => setSelected({ id, kind: "cloud", label: id })}
						onModelPick={(provider, id) =>
							setSelected({
								id,
								kind: "cloud",
								label: id,
								provider: provider ?? undefined,
							})
						}
						placeholder="Select a cloud model"
						target={target}
						value={current?.id ?? ""}
					/>
				)}
			</SettingsCard>
			{current ? (
				<ModelParameterEditor
					key={`${current.kind}:${current.engine ?? current.provider ?? ""}:${current.id}`}
					model={current}
					target={target}
				/>
			) : null}
		</SettingsSection>
	);
}
