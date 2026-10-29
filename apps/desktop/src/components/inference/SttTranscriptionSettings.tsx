import { Button } from "@ryu/ui/components/button.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import {
	BoolField,
	FieldGrid,
	FieldGroup,
	NumberField,
	TextField,
} from "./fields.tsx";

const transcriptionConfigSchema = z.object({
	beam_size: z.number().optional(),
	best_of: z.number().optional(),
	extra: z.record(z.string(), z.string()).optional(),
	language: z.string().optional(),
	max_context: z.number().optional(),
	max_len: z.number().optional(),
	no_context: z.boolean().optional(),
	prompt: z.string().optional(),
	suppress_nst: z.boolean().optional(),
	temperature: z.number().optional(),
	temperature_inc: z.number().optional(),
	translate: z.boolean().optional(),
});
type TranscriptionConfig = z.infer<typeof transcriptionConfigSchema>;

function preferenceKey(engineId: string): string {
	return `engine.transcription.${engineId}`;
}

function parseConfig(raw: string | null): TranscriptionConfig {
	if (!raw) {
		return {};
	}
	const parsed = transcriptionConfigSchema.safeParse(JSON.parse(raw));
	return parsed.success ? parsed.data : {};
}

function EngineTranscriptionEditor({
	engineId,
	initial,
	target,
}: {
	engineId: string;
	initial: TranscriptionConfig;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<TranscriptionConfig>(initial);
	const [extraText, setExtraText] = useState(() =>
		initial.extra ? JSON.stringify(initial.extra, null, 2) : ""
	);
	const [extraError, setExtraError] = useState<string | null>(null);
	const queryKey = ["engine", "transcription-settings", target.url, engineId];
	const save = useMutation({
		mutationFn: async (config: TranscriptionConfig) => {
			const saved = await setPreference(
				target,
				preferenceKey(engineId),
				JSON.stringify(config)
			);
			if (!saved) {
				throw new Error("Could not save transcription settings");
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey });
		},
	});

	const updateExtra = (text: string) => {
		setExtraText(text);
		if (!text.trim()) {
			setExtraError(null);
			setDraft((current) => ({ ...current, extra: undefined }));
			return;
		}
		try {
			const parsed = z
				.record(z.string(), z.string())
				.safeParse(JSON.parse(text));
			if (!parsed.success) {
				setExtraError("Use a JSON object with string values.");
				return;
			}
			setExtraError(null);
			setDraft((current) => ({ ...current, extra: parsed.data }));
		} catch {
			setExtraError("Invalid JSON");
		}
	};

	const setNumber = (
		key: keyof TranscriptionConfig,
		value: number | undefined
	) =>
		setDraft((current) => {
			const next = { ...current };
			if (value === undefined) {
				delete next[key];
			} else {
				Object.assign(next, { [key]: value });
			}
			return next;
		});

	return (
		<SettingsSection caption="Defaults for transcriptions routed to this engine. Blank values keep the engine's own defaults.">
			<SettingsCard className="flex flex-col gap-5">
				<FieldGroup
					description="Whisper.cpp and audio.cpp apply these fields per transcription request."
					title="Recognition"
				>
					<FieldGrid>
						<TextField
							hint="Language code, or auto for detection."
							label="Language"
							onChange={(language) =>
								setDraft((current) => ({
									...current,
									language: language || undefined,
								}))
							}
							value={draft.language}
						/>
						<NumberField
							label="Temperature"
							max={1}
							min={0}
							onChange={(value) => setNumber("temperature", value)}
							step={0.05}
							value={draft.temperature}
						/>
						<NumberField
							label="Temperature increment"
							max={1}
							min={0}
							onChange={(value) => setNumber("temperature_inc", value)}
							step={0.05}
							value={draft.temperature_inc}
						/>
						<NumberField
							hint="Used when temperature is above zero."
							label="Best of"
							min={1}
							onChange={(value) => setNumber("best_of", value)}
							step={1}
							value={draft.best_of}
						/>
						<NumberField
							hint="Values above 1 enable beam search in whisper.cpp."
							label="Beam size"
							min={1}
							onChange={(value) => setNumber("beam_size", value)}
							step={1}
							value={draft.beam_size}
						/>
						<NumberField
							label="Max context"
							min={-1}
							onChange={(value) => setNumber("max_context", value)}
							step={1}
							value={draft.max_context}
						/>
						<NumberField
							label="Max segment length"
							min={0}
							onChange={(value) => setNumber("max_len", value)}
							step={1}
							value={draft.max_len}
						/>
					</FieldGrid>
					<div className="flex flex-col gap-1">
						<BoolField
							label="Translate to English"
							onChange={(translate) =>
								setDraft((current) => ({ ...current, translate }))
							}
							value={draft.translate}
						/>
						<BoolField
							label="Disable previous audio context"
							onChange={(no_context) =>
								setDraft((current) => ({ ...current, no_context }))
							}
							value={draft.no_context}
						/>
						<BoolField
							label="Suppress non-speech tokens"
							onChange={(suppress_nst) =>
								setDraft((current) => ({ ...current, suppress_nst }))
							}
							value={draft.suppress_nst}
						/>
					</div>
					<TextField
						hint="Optional context or vocabulary to guide recognition."
						label="Prompt"
						onChange={(prompt) =>
							setDraft((current) => ({
								...current,
								prompt: prompt || undefined,
							}))
						}
						value={draft.prompt}
					/>
				</FieldGroup>
				<FieldGroup
					description="String-valued multipart fields supported by your upstream engine build."
					title="Additional fields"
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`stt-extra-${engineId}`}>Extra fields (JSON)</Label>
						<Textarea
							aria-invalid={Boolean(extraError)}
							className="min-h-24"
							id={`stt-extra-${engineId}`}
							onChange={(event) => updateExtra(event.target.value)}
							placeholder={'{\n  "vad": "true"\n}'}
							value={extraText}
							variant="code-caption"
						/>
						{extraError ? (
							<p className="text-status-destructive text-xs" role="alert">
								{extraError}
							</p>
						) : null}
					</div>
				</FieldGroup>
				<div className="flex items-center gap-2">
					<Button
						disabled={save.isPending || Boolean(extraError)}
						loading={save.isPending}
						onClick={() => save.mutate(draft)}
					>
						Save transcription settings
					</Button>
					{save.isSuccess ? (
						<span className="text-muted-foreground text-xs">
							Saved for this engine
						</span>
					) : null}
					{save.isError ? (
						<p className="text-status-destructive text-xs" role="alert">
							{save.error instanceof Error
								? save.error.message
								: "Could not save transcription settings"}
						</p>
					) : null}
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

export function SttTranscriptionSettings({
	engineId,
	adapterSupported = true,
	adapterNote,
}: {
	engineId: string;
	adapterSupported?: boolean;
	adapterNote?: string;
}) {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const queryKey = ["engine", "transcription-settings", target.url, engineId];
	const query = useQuery({
		queryKey,
		queryFn: async () =>
			parseConfig(await getPreference(target, preferenceKey(engineId))),
	});

	if (query.isLoading && !query.data) {
		return (
			<div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
				<Spinner className="size-4" />
				Loading transcription settings…
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
					Could not load transcription settings.
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

	const settingsNote =
		adapterNote ??
		(adapterSupported
			? null
			: "These values are saved for Parakeet, but the current in-process runtime does not consume request options yet.");

	return (
		<div className="flex flex-col gap-2">
			{settingsNote ? (
				<p className="rounded-md border border-dashed px-3 py-2 text-muted-foreground text-xs">
					{settingsNote}
				</p>
			) : null}
			{query.data ? (
				<EngineTranscriptionEditor
					engineId={engineId}
					initial={query.data}
					key={engineId}
					target={target}
				/>
			) : null}
		</div>
	);
}
