// Copy-to-clipboard launch profiles for ModelLaunchConfigSection: the generated
// Ollama Modelfile profile and the raw passthrough / runtime-args group.

import { Button } from "@ryu/ui/components/button.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { LaunchConfig, SamplingConfig } from "@/src/lib/api/inference.ts";
import { FieldGroup, StringListField } from "./fields.tsx";
import {
	type LaunchFieldsApi,
	rawLaunchDescription,
} from "./ModelLaunchConfigSection-rules.ts";

/** The Ollama Modelfile profile generated from the launch and sampling drafts. */
export function buildOllamaProfile(
	draft: LaunchConfig,
	ollamaSampling: SamplingConfig
): string {
	return [
		"FROM <model-id>",
		draft.ctx_size === undefined ? null : `PARAMETER num_ctx ${draft.ctx_size}`,
		draft.gpu_layers === undefined
			? null
			: `PARAMETER num_gpu ${draft.gpu_layers}`,
		draft.batch_size === undefined
			? null
			: `PARAMETER num_batch ${draft.batch_size}`,
		draft.threads === undefined
			? null
			: `PARAMETER num_thread ${draft.threads}`,
		draft.mlock === true ? "PARAMETER use_mlock true" : null,
		draft.no_mmap === true ? "PARAMETER use_mmap false" : null,
		ollamaSampling.top_k === undefined
			? null
			: `PARAMETER top_k ${ollamaSampling.top_k}`,
		ollamaSampling.min_p === undefined
			? null
			: `PARAMETER min_p ${ollamaSampling.min_p}`,
		ollamaSampling.typical_p === undefined
			? null
			: `PARAMETER typical_p ${ollamaSampling.typical_p}`,
		ollamaSampling.repeat_penalty === undefined
			? null
			: `PARAMETER repeat_penalty ${ollamaSampling.repeat_penalty}`,
		ollamaSampling.repeat_last_n === undefined
			? null
			: `PARAMETER repeat_last_n ${ollamaSampling.repeat_last_n}`,
		ollamaSampling.mirostat === undefined
			? null
			: `PARAMETER mirostat ${ollamaSampling.mirostat}`,
		ollamaSampling.mirostat_tau === undefined
			? null
			: `PARAMETER mirostat_tau ${ollamaSampling.mirostat_tau}`,
		ollamaSampling.mirostat_eta === undefined
			? null
			: `PARAMETER mirostat_eta ${ollamaSampling.mirostat_eta}`,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

export function OllamaProfileGroup({
	copyOllamaProfile,
	ollamaEngine,
	ollamaProfile,
	profileCopied,
	profileCopyError,
}: {
	copyOllamaProfile: () => Promise<void>;
	ollamaEngine: boolean;
	ollamaProfile: string;
	profileCopied: boolean;
	profileCopyError: boolean;
}) {
	return (
		<>
			{ollamaEngine ? (
				<FieldGroup
					description="Ryu does not create a derived Ollama model yet. Copy this profile, replace the model id, then use it in your Ollama Modelfile."
					title="Generated Modelfile profile"
				>
					<Textarea
						aria-label="Generated Ollama Modelfile"
						className="min-h-24"
						readOnly
						value={ollamaProfile}
						variant="code-caption"
					/>
					<div className="flex items-center gap-2">
						<Button
							onClick={() => void copyOllamaProfile()}
							size="sm"
							variant="outline"
						>
							Copy Modelfile profile
						</Button>
						{profileCopied ? (
							<span className="text-muted-foreground text-xs">Copied</span>
						) : null}
						{profileCopyError ? (
							<p className="text-status-destructive text-xs" role="alert">
								Clipboard access was unavailable.
							</p>
						) : null}
					</div>
				</FieldGroup>
			) : null}
		</>
	);
}

export function RawPassthroughGroup({
	copyRuntimeArgs,
	draft,
	engineId,
	fields: { set },
	manualRuntimeLaunch,
	profileCopied,
	profileCopyError,
	rawArgEngine,
}: {
	copyRuntimeArgs: () => Promise<void>;
	draft: LaunchConfig;
	engineId: string | undefined;
	fields: LaunchFieldsApi;
	manualRuntimeLaunch: boolean;
	profileCopied: boolean;
	profileCopyError: boolean;
	rawArgEngine: boolean;
}) {
	return (
		<>
			{rawArgEngine ? (
				<FieldGroup
					description={rawLaunchDescription(engineId, manualRuntimeLaunch)}
					title={
						manualRuntimeLaunch ? "Runtime launch profile" : "Raw passthrough"
					}
				>
					<StringListField
						hint="One arg per entry, e.g. --spec-type, ngram-cache"
						label={manualRuntimeLaunch ? "Runtime args" : "Extra args"}
						onChange={(v) => set("extra_args", v)}
						placeholder="--flag, value"
						value={draft.extra_args}
					/>
					{manualRuntimeLaunch ? (
						<div className="flex items-center gap-2">
							<Button
								disabled={!draft.extra_args?.length}
								onClick={() => void copyRuntimeArgs()}
								size="sm"
								variant="outline"
							>
								Copy runtime args
							</Button>
							{profileCopied ? (
								<span className="text-muted-foreground text-xs">Copied</span>
							) : null}
							{profileCopyError ? (
								<p className="text-status-destructive text-xs" role="alert">
									Clipboard access was unavailable.
								</p>
							) : null}
						</div>
					) : null}
				</FieldGroup>
			) : null}
		</>
	);
}
