import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { z } from "zod";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	getSpeechProcessingPrefs,
	SPEECH_PROCESSING_ENGINES,
	type SpeechProcessingPrefs,
	setSpeechProcessingPrefs,
} from "@/src/lib/api/preferences.ts";
import { EnumField, FieldGrid, FieldGroup } from "./fields.tsx";

const SPEECH_STYLES = [
	{ value: "casual", label: "Casual" },
	{ value: "semi-casual", label: "Semi-casual" },
	{ value: "semi-formal", label: "Semi-formal" },
	{ value: "formal", label: "Formal" },
];

const SPEECH_STRUCTURES = [
	{ value: "prose", label: "Prose" },
	{ value: "lists", label: "Lists" },
];

const SPEECH_CONTEXTS = [
	{ value: "general", label: "General" },
	{ value: "email", label: "Email" },
];

function SpeechProcessingEditor({
	initial,
	target,
}: {
	initial: SpeechProcessingPrefs;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<SpeechProcessingPrefs>(initial);
	const queryKey = ["engine", "speech-processing-settings", target.url];
	const save = useMutation({
		mutationFn: async (prefs: SpeechProcessingPrefs) => {
			const saved = await setSpeechProcessingPrefs(target, prefs);
			if (!saved) {
				throw new Error("Could not save Speech Processing settings");
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey });
		},
	});
	const engineOptions = SPEECH_PROCESSING_ENGINES.map((entry) => ({
		value: entry.engine,
		label: entry.label,
	}));

	return (
		<SettingsSection caption="These node-wide defaults are shared with the Speech Processing layer on the Computer dialog's Voice & sandbox page and Dictation settings.">
			<SettingsCard className="flex flex-col gap-5">
				<FieldGroup title="Engine">
					<EnumField
						label="Speech Processing engine"
						onChange={(engine) =>
							setDraft((current) => ({
								...current,
								engine: z
									.enum(SPEECH_PROCESSING_ENGINES.map((entry) => entry.engine))
									.catch(current.engine)
									.parse(engine),
							}))
						}
						options={engineOptions}
						value={draft.engine}
					/>
				</FieldGroup>
				<FieldGroup title="Cleanup defaults">
					<FieldGrid>
						<EnumField
							label="Style"
							onChange={(styling) =>
								setDraft((current) => ({
									...current,
									styling: z
										.enum(["casual", "semi-casual", "semi-formal", "formal"])
										.catch(current.styling)
										.parse(styling),
								}))
							}
							options={SPEECH_STYLES}
							value={draft.styling}
						/>
						<EnumField
							label="Structure"
							onChange={(structure) =>
								setDraft((current) => ({
									...current,
									structure: z
										.enum(["prose", "lists"])
										.catch(current.structure)
										.parse(structure),
								}))
							}
							options={SPEECH_STRUCTURES}
							value={draft.structure}
						/>
						<EnumField
							label="Context"
							onChange={(context) =>
								setDraft((current) => ({
									...current,
									context: z
										.enum(["general", "email"])
										.catch(current.context)
										.parse(context),
								}))
							}
							options={SPEECH_CONTEXTS}
							value={draft.context}
						/>
					</FieldGrid>
				</FieldGroup>
				<div className="flex items-center gap-2">
					<Button
						disabled={save.isPending}
						loading={save.isPending}
						onClick={() => save.mutate(draft)}
					>
						Save Speech Processing settings
					</Button>
					{save.isSuccess ? (
						<span className="text-muted-foreground text-xs">Saved</span>
					) : null}
					{save.isError ? (
						<p className="text-status-destructive text-xs" role="alert">
							{save.error instanceof Error
								? save.error.message
								: "Could not save Speech Processing settings"}
						</p>
					) : null}
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

export function SpeechProcessingEngineSettings() {
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.url, node.token, node.userJwt]
	);
	const queryKey = ["engine", "speech-processing-settings", target.url];
	const query = useQuery({
		queryKey,
		queryFn: () => getSpeechProcessingPrefs(target),
	});

	if (query.isLoading && !query.data) {
		return (
			<div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
				<Spinner className="size-4" />
				Loading Speech Processing settings…
			</div>
		);
	}
	if (query.isError && !query.data) {
		return (
			<div
				className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
				role="alert"
			>
				<p className="text-sm text-status-destructive">
					Could not load Speech Processing settings.
				</p>
				<Button
					disabled={query.isFetching}
					loading={query.isFetching}
					onClick={() => void query.refetch()}
					size="sm"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}
	return query.data ? (
		<SpeechProcessingEditor
			initial={query.data}
			key={target.url}
			target={target}
		/>
	) : null;
}
