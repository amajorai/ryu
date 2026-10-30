import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getEngineSamplingConfig,
	type SamplingConfig,
	saveEngineSamplingConfig,
} from "@/src/lib/api/inference.ts";
import { AdvancedInferenceSection } from "./AdvancedInferenceSection.tsx";
import { InferenceLoadError } from "./fields.tsx";
import { EngineLaunchConfigSection } from "./ModelLaunchConfigSection.tsx";

const ENGINES_WITH_LAUNCH_ADAPTER = new Set([
	"llamacpp",
	"ollama",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
	"mlx-serve",
	"omlx",
	"apfel",
	"mesh-llm",
]);

const ENGINES_WITH_EXTENDED_SAMPLERS = new Set(["llamacpp", "vllm", "sglang"]);

const ENGINE_LAUNCH_NOTES = new Map<string, string>([
	[
		"apfel",
		"Ryu applies native options and additional flags when it starts apfel in serve mode. Sampling and context are set per request (serve mode rejects them as launch flags). If Ryu adopts an already-running server, configure that process in apfel instead.",
	],
	[
		"docker-model-runner",
		"Ryu connects to Docker Model Runner. Configure model loading and hardware in Docker Desktop; Ryu can still send per-engine chat request defaults.",
	],
	[
		"freetoken",
		"Ryu connects to the FreeToken server. Configure its runtime and model in FreeToken; Ryu can still send per-engine chat request defaults.",
	],
	[
		"lemonade",
		"Ryu connects to Lemonade Server. Configure model loading and hardware in Lemonade; Ryu can still send per-engine chat request defaults.",
	],
	[
		"magnitude",
		"Ryu connects to Magnitude. Download models and tune hardware in Magnitude; Ryu can still send per-engine chat request defaults.",
	],
	[
		"llama-swap",
		"llama-swap owns its model configuration and process lifecycle. Ryu can still send per-engine chat request defaults.",
	],
	[
		"mesh-llm",
		"Ryu applies these launch settings when it starts Mesh LLM. An already-running Mesh LLM that Ryu adopts keeps its own configuration. Options were checked against Mesh LLM v0.78.1; older installs may reject newer flags.",
	],
	[
		"mlx-serve",
		"Ryu always starts MLX Serve itself; native options and additional flags apply on the next start. MLX Serve refuses unknown flags, so the listed options are limited to those in MLX Serve 26.8.10 and later.",
	],
	[
		"omlx",
		"Most oMLX options are passed as its server environment and apply only while Ryu runs it. Memory guard, hot cache size, and SSE keep-alive are flags that oMLX also saves to its own settings, so clearing them here does not revert them until you change them in oMLX.",
	],
]);

function EngineSamplingEditor({
	engineId,
	initial,
	localEngine,
	target,
}: {
	engineId: string;
	initial: SamplingConfig;
	localEngine: boolean;
	target: ApiTarget;
}) {
	const queryClient = useQueryClient();
	const queryKey = ["engine", "sampling-config", target.url, engineId];
	const [draft, setDraft] = useState<SamplingConfig>(initial);
	const mutation = useMutation({
		mutationFn: (config: SamplingConfig) =>
			saveEngineSamplingConfig(target, engineId, config),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey });
		},
	});

	return (
		<div className="flex flex-col gap-2">
			<AdvancedInferenceSection
				engineId={engineId}
				localEngine={localEngine}
				onChange={setDraft}
				onSave={() => mutation.mutate(draft)}
				saved={mutation.isSuccess}
				saveError={
					mutation.isError
						? mutation.error instanceof Error
							? mutation.error.message
							: "Could not save engine defaults"
						: null
				}
				saving={mutation.isPending}
				scope="engine"
				value={draft}
			/>
		</div>
	);
}

export function EngineInferenceSettings({ engineId }: { engineId: string }) {
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const samplingQuery = useQuery({
		queryKey: ["engine", "sampling-config", target.url, engineId],
		queryFn: () => getEngineSamplingConfig(target, engineId),
	});
	const launchAdapter = ENGINES_WITH_LAUNCH_ADAPTER.has(engineId);

	return (
		<div className="flex flex-col gap-3">
			{samplingQuery.isLoading && !samplingQuery.data ? (
				<div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Loading engine defaults…
				</div>
			) : samplingQuery.isError && !samplingQuery.data ? (
				<InferenceLoadError
					error={samplingQuery.error}
					message="Couldn't load this engine's sampling defaults."
					onRetry={() => void samplingQuery.refetch()}
				/>
			) : samplingQuery.data ? (
				<EngineSamplingEditor
					engineId={engineId}
					initial={samplingQuery.data}
					key={engineId}
					localEngine={ENGINES_WITH_EXTENDED_SAMPLERS.has(engineId)}
					target={target}
				/>
			) : null}

			{launchAdapter && !ENGINE_LAUNCH_NOTES.has(engineId) ? null : (
				<div className="py-2 text-muted-foreground text-xs">
					{ENGINE_LAUNCH_NOTES.get(engineId) ??
						"This engine manages its own process and model loading. Ryu still applies chat request defaults and raw request fields supported by the server."}
				</div>
			)}
			<EngineLaunchConfigSection
				engineId={engineId}
				launchAdapterSupported={launchAdapter}
			/>
		</div>
	);
}
