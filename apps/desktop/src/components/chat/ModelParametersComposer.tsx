// apps/desktop/src/components/chat/ModelParametersComposer.tsx
//
// The chat composer's "Parameters" settings section: the node's presets for the
// current chat model, plus an "Edit parameters…" row that opens the full editor
// (the same one as Gateway → LLM Providers → Model parameters) in a dialog.
// Picking a preset saves it to the model, so it applies from the next turn.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { sileo } from "sileo";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import {
	LOCAL_ENGINE_IDS,
	ModelParameterEditor,
	presetFitsKind,
	presetsQueryKey,
	type SelectedModel,
} from "@/src/components/settings/ModelParametersSettings.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyInferencePreset,
	getSamplingFieldSupport,
	type InferencePreset,
	listInferencePresets,
} from "@/src/lib/api/inference.ts";

const EDIT_ITEM_ID = "__edit_model_parameters__";

/**
 * The model whose parameters a chat turn uses, or `null` when the turn goes to
 * an external agent (ACP, A2A, SDK app) that applies its own settings.
 */
export function chatParameterModel({
	engine,
	modelId,
	providerId,
}: {
	/** The selected agent's engine binding (`engineForAgent`). */
	engine: string | null;
	modelId: string | null;
	/** Set when the user picked a model from a specific cloud provider. */
	providerId?: string | null;
}): SelectedModel | null {
	if (!modelId) {
		return null;
	}
	if (providerId) {
		return { id: modelId, kind: "cloud", label: modelId, provider: providerId };
	}
	if (engine && LOCAL_ENGINE_IDS.has(engine)) {
		return { engine, id: modelId, kind: "local", label: modelId };
	}
	// Ryu's own agent (and an unbound one) routes through the Gateway.
	if (!engine || engine === "ryu") {
		return { id: modelId, kind: "cloud", label: modelId };
	}
	return null;
}

/**
 * Composer settings section + dialog for the chat's model parameters. Returns
 * no section when `model` is `null`.
 */
export function useModelParametersComposer(
	model: SelectedModel | null,
	target: ApiTarget
): { dialog: ReactNode; section: ComposerSettingsSection | null } {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(false);
	const presetsQuery = useQuery({
		queryKey: presetsQueryKey(target.url),
		queryFn: () => listInferencePresets(target),
		enabled: model !== null,
		staleTime: 60 * 1000,
	});
	const supportQuery = useQuery({
		queryKey: [
			"inference",
			"sampling-fields",
			target.url,
			model?.engine ?? "",
			model?.provider ?? "",
		],
		queryFn: () =>
			getSamplingFieldSupport(target, {
				engine: model?.engine,
				provider: model?.provider,
			}),
		enabled: model !== null,
		staleTime: 5 * 60 * 1000,
	});

	const apply = useMutation({
		mutationFn: ({
			preset,
			selected,
		}: {
			preset: InferencePreset;
			selected: SelectedModel;
		}) =>
			applyInferencePreset(
				target,
				{ id: selected.id, local: selected.kind === "local" },
				preset,
				new Set(supportQuery.data?.fields ?? [])
			),
		onSuccess: (sampling, { preset, selected }) => {
			queryClient.setQueryData(
				["models", "sampling-config", target.url, selected.id],
				sampling
			);
			queryClient
				.invalidateQueries({
					queryKey: ["models", "launch-config", selected.id],
				})
				.catch(() => undefined);
			sileo.success({
				title: tl("Applied “{presetName}” to {modelLabel}", {
					presetName: preset.name,
					modelLabel: selected.label,
				}),
			});
		},
		onError: (error) =>
			sileo.error({
				title: "Could not apply preset",
				description:
					error instanceof Error && error.message
						? error.message
						: "Try again.",
			}),
	});

	const presets = useMemo(
		() =>
			model
				? (presetsQuery.data ?? []).filter((preset) =>
						presetFitsKind(preset, model.kind)
					)
				: [],
		[model, presetsQuery.data]
	);

	// Worded outside the memo: the string is stable across renders, `tl` is not.
	const editDescription = model
		? tl("Tune {modelLabel} and manage presets", { modelLabel: model.label })
		: "";

	const section = useMemo<ComposerSettingsSection | null>(() => {
		if (!model) {
			return null;
		}
		return {
			key: "model-parameters",
			ariaLabel: "Model parameters",
			label: "Parameters",
			activeName: "Model",
			loading: presetsQuery.isLoading || supportQuery.isLoading,
			items: [
				...presets.map((preset) => ({
					id: preset.id,
					name: preset.name,
					description: preset.description ?? null,
				})),
				{
					id: EDIT_ITEM_ID,
					name: "Edit parameters…",
					description: editDescription,
				},
			],
			value: undefined,
			onChange: (id: string) => {
				if (id === EDIT_ITEM_ID) {
					setEditing(true);
					return;
				}
				const preset = presets.find((candidate) => candidate.id === id);
				if (preset && supportQuery.data) {
					apply.mutate({ preset, selected: model });
				}
			},
		};
	}, [
		model,
		presets,
		presetsQuery.isLoading,
		supportQuery.isLoading,
		supportQuery.data,
		apply,
		editDescription,
	]);

	const dialog = model ? (
		<Dialog onOpenChange={setEditing} open={editing}>
			<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Model parameters</DialogTitle>
					<DialogDescription>
						{tl(
							"{modelLabel} · saved on this node and applied from the next turn.",
							{ modelLabel: model.label }
						)}
					</DialogDescription>
				</DialogHeader>
				{editing ? (
					<ModelParameterEditor
						key={`${model.kind}:${model.engine ?? model.provider ?? ""}:${model.id}`}
						model={model}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	) : null;

	return { dialog, section };
}
