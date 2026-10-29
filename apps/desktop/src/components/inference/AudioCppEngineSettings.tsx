import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
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
import { EnumField, FieldGrid, FieldGroup, NumberField } from "./fields.tsx";

const PREFERENCE_KEY = "engine.audiocpp.runtime";

interface AudioCppRuntimeSettings {
	backend?: "auto" | "cpu" | "cuda" | "vulkan" | "metal";
	device?: number;
	max_loaded_models?: number;
	threads?: number;
}

function parseSettings(raw: string | null): AudioCppRuntimeSettings {
	if (!raw) {
		return {};
	}
	try {
		return z
			.object({
				backend: z
					.enum(["auto", "cpu", "cuda", "vulkan", "metal"])
					.optional()
					.catch(undefined),
				device: z.number().int().nonnegative().optional().catch(undefined),
				max_loaded_models: z
					.number()
					.int()
					.positive()
					.optional()
					.catch(undefined),
				threads: z.number().int().positive().optional().catch(undefined),
			})
			.parse(JSON.parse(raw));
	} catch {
		return {};
	}
}

function targetFor(node: ReturnType<typeof useActiveNode>): ApiTarget {
	return {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
}

function AudioCppSettingsEditor({
	initial,
	target,
}: {
	initial: AudioCppRuntimeSettings;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<AudioCppRuntimeSettings>(initial);
	const key = ["engine", "audiocpp-runtime-settings", target.url];
	const save = useMutation({
		mutationFn: async (settings: AudioCppRuntimeSettings) => {
			const saved = await setPreference(
				target,
				PREFERENCE_KEY,
				JSON.stringify(settings)
			);
			if (!saved) {
				throw new Error("Could not save audio.cpp settings");
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: key });
		},
	});

	return (
		<SettingsSection caption="Configure audio.cpp's hardware use. Changes take effect when the audio.cpp sidecar next starts.">
			<SettingsCard className="flex flex-col gap-5">
				<FieldGroup title="Runtime">
					<FieldGrid>
						<EnumField
							hint="Auto follows the platform default unless an environment override is set."
							label="Backend"
							onChange={(value) =>
								setDraft((current) => ({
									...current,
									backend: z
										.enum(["auto", "cpu", "cuda", "vulkan", "metal"])
										.optional()
										.parse(value),
								}))
							}
							options={[
								{ value: "auto", label: "Automatic" },
								{ value: "cpu", label: "CPU" },
								{ value: "metal", label: "Metal" },
								{ value: "cuda", label: "CUDA" },
								{ value: "vulkan", label: "Vulkan" },
							]}
							value={draft.backend ?? "auto"}
						/>
						<NumberField
							hint="Device index. Leave blank for device 0."
							label="Device"
							min={0}
							onChange={(device) =>
								setDraft((current) => ({ ...current, device }))
							}
							step={1}
							value={draft.device}
						/>
						<NumberField
							hint="Leave blank to use audio.cpp's default of 4."
							label="Threads"
							min={1}
							onChange={(threads) =>
								setDraft((current) => ({ ...current, threads }))
							}
							step={1}
							value={draft.threads}
						/>
						<NumberField
							hint="Maximum number of audio models held in memory."
							label="Max loaded models"
							min={1}
							onChange={(max_loaded_models) =>
								setDraft((current) => ({ ...current, max_loaded_models }))
							}
							step={1}
							value={draft.max_loaded_models}
						/>
					</FieldGrid>
				</FieldGroup>
				<div className="flex items-center gap-2">
					<Button
						disabled={save.isPending}
						loading={save.isPending}
						onClick={() => save.mutate(draft)}
					>
						Save audio.cpp settings
					</Button>
					{save.isSuccess ? (
						<span className="text-muted-foreground text-xs">Saved</span>
					) : null}
					{save.isError ? (
						<p className="text-status-destructive text-xs" role="alert">
							{save.error instanceof Error
								? save.error.message
								: "Could not save audio.cpp settings"}
						</p>
					) : null}
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

export function AudioCppEngineSettings() {
	const node = useActiveNode();
	const target = targetFor(node);
	const query = useQuery({
		queryKey: ["engine", "audiocpp-runtime-settings", target.url],
		queryFn: async () =>
			parseSettings(await getPreference(target, PREFERENCE_KEY)),
	});

	if (query.isLoading && !query.data) {
		return (
			<div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
				<Spinner className="size-4" />
				Loading audio.cpp settings…
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
					Could not load audio.cpp settings.
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
		<AudioCppSettingsEditor initial={query.data} target={target} />
	) : null;
}
