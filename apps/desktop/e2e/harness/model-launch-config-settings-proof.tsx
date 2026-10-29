import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { ModelLaunchConfigSection } from "../../src/components/inference/ModelLaunchConfigSection.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { LaunchConfig } from "../../src/lib/api/inference.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const launchConfigSchema = z.object({
	batch_size: z.number().optional(),
	cache_reuse: z.number().optional(),
	cache_type_k: z.string().optional(),
	cache_type_v: z.string().optional(),
	chat_template: z.string().optional(),
	chat_template_file: z.string().optional(),
	cont_batching: z.boolean().optional(),
	cpu_moe: z.boolean().optional(),
	ctx_size: z.number().optional(),
	draft_max: z.number().optional(),
	draft_min: z.number().optional(),
	draft_model: z.string().optional(),
	draft_p_min: z.number().optional(),
	dtype: z.string().optional(),
	enable_prefix_caching: z.boolean().optional(),
	extra_args: z.array(z.string()).optional(),
	flash_attn: z.enum(["on", "off", "auto"]).optional(),
	gpu_layers: z.number().optional(),
	gpu_memory_utilization: z.number().optional(),
	jinja: z.boolean().optional(),
	kv_cache_dtype: z.string().optional(),
	kv_unified: z.boolean().optional(),
	max_num_seqs: z.number().optional(),
	max_running_requests: z.number().optional(),
	mem_fraction_static: z.number().optional(),
	mlock: z.boolean().optional(),
	n_cpu_moe: z.number().optional(),
	no_mmap: z.boolean().optional(),
	override_tensor: z.string().optional(),
	parallel: z.number().optional(),
	quantization: z.string().optional(),
	rope_freq_base: z.number().optional(),
	rope_freq_scale: z.number().optional(),
	rope_scale: z.number().optional(),
	rope_scaling: z.string().optional(),
	sleep_idle_secs: z.number().optional(),
	spec_type: z.string().optional(),
	speculative_algorithm: z.string().optional(),
	speculative_config: z.record(z.string(), z.json()).optional(),
	tensor_parallel: z.number().optional(),
	threads: z.number().optional(),
	ubatch_size: z.number().optional(),
});
const storedConfigsSchema = z.object({
	configs: z.record(z.string(), launchConfigSchema),
	preferences: z.record(z.string(), z.string()),
});

const STORAGE_KEY = "ryu:model-launch-config-proof:configs";
const MODEL_ALPHA = "owner/model-a-q4";
const MODEL_BETA = "team/model-b-q5";

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

interface StoredConfigs {
	configs: Record<string, LaunchConfig>;
	preferences: Record<string, string>;
}

interface FailurePlan {
	message: string;
	method: string;
	path: string;
	status: number;
}

interface ProofState {
	armFailure: (failure: FailurePlan) => void;
	calls: () => RequestRecord[];
	holdNextRead: () => void;
	refresh: (modelId: string) => Promise<void>;
	releasePendingRead: () => void;
	snapshot: () => StoredConfigs & { calls: RequestRecord[] };
}

declare global {
	interface Window {
		__modelLaunchConfigProof: ProofState;
	}
}

function initialConfigs(): StoredConfigs {
	return {
		configs: {
			[MODEL_ALPHA]: {
				batch_size: 256,
				cache_reuse: 256,
				cache_type_k: "q8_0",
				cache_type_v: "f16",
				chat_template_file: "",
				cont_batching: true,
				cpu_moe: false,
				ctx_size: 8192,
				draft_max: 4,
				draft_min: 2,
				dtype: "float16",
				extra_args: ["--threads", "8"],
				flash_attn: "auto",
				gpu_layers: -1,
				gpu_memory_utilization: 0.8,
				jinja: false,
				kv_cache_dtype: "fp8",
				kv_unified: false,
				mem_fraction_static: 0.75,
				mlock: false,
				n_cpu_moe: 0,
				no_mmap: false,
				override_tensor: "",
				parallel: 4,
				quantization: "q4_k_m",
				spec_type: "ngram-simple",
				speculative_algorithm: "ngram",
				tensor_parallel: 2,
				threads: 8,
				ubatch_size: 128,
			},
			[MODEL_BETA]: {
				ctx_size: 16_384,
				flash_attn: "off",
				parallel: 2,
				threads: 16,
			},
		},
		preferences: {
			"inference.engine.ollama": JSON.stringify({
				min_p: 0.1,
				mirostat: 2,
				repeat_penalty: 1.15,
				top_k: 40,
			}),
			"model.launch.engine.llamacpp": JSON.stringify({
				draft_max: 6,
				draft_min: 2,
				draft_p_min: 0.2,
				spec_type: "ngram-simple",
			}),
			"model.launch.engine.lemonade": JSON.stringify({
				extra_args: ["--host", "127.0.0.1", "--port", "1234"],
			}),
			"model.launch.engine.ollama": JSON.stringify({
				batch_size: 512,
				ctx_size: 4096,
				gpu_layers: 4,
				mlock: false,
				no_mmap: false,
				threads: 12,
			}),
			"model.launch.engine.sglang": JSON.stringify({
				draft_max: 5,
				draft_model: "/models/sglang-draft",
				max_running_requests: 12,
				mem_fraction_static: 0.75,
				speculative_algorithm: "ngram",
				tensor_parallel: 2,
			}),
			"model.launch.engine.vllm": JSON.stringify({
				draft_max: 4,
				draft_model: "/models/vllm-draft",
				gpu_memory_utilization: 0.75,
				max_num_seqs: 8,
				speculative_config: {
					method: "ngram",
					num_speculative_tokens: 4,
				},
				tensor_parallel: 2,
			}),
		},
	};
}

function readConfigs(): StoredConfigs {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			return storedConfigsSchema.parse(JSON.parse(raw));
		}
	} catch {
		// A broken proof store resets to the known model profiles.
	}
	const state = initialConfigs();
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	return state;
}

function writeConfigs(state: StoredConfigs): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function requestBody(init?: RequestInit) {
	if (!isNativeText(init?.body)) {
		return undefined;
	}
	try {
		return parseProofJson(init.body);
	} catch {
		return init.body;
	}
}

function installFixture(): RequestRecord[] {
	const calls: RequestRecord[] = [];
	let failure: FailurePlan | null = null;
	let holdNextRead = false;
	let releaseRead: () => void = () => undefined;
	const originalFetch = globalThis.fetch.bind(globalThis);
	window.__modelLaunchConfigProof = {
		armFailure: (nextFailure) => {
			failure = nextFailure;
		},
		calls: () => [...calls],
		holdNextRead: () => {
			holdNextRead = true;
		},
		releasePendingRead: () => releaseRead(),
		refresh: async (modelId) => {
			await queryClient.invalidateQueries({
				queryKey: ["models", "launch-config", modelId, NODE.url],
			});
		},
		snapshot: () => ({ ...readConfigs(), calls: [...calls] }),
	};
	globalThis.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.origin);
		const route = url.pathname.match(/^\/api\/models\/([^/]+)\/launch-config$/);
		const preferenceRoute = url.pathname.match(/^\/api\/preferences\/(.+)$/);
		if (!(route || preferenceRoute)) {
			return originalFetch(input, init);
		}
		const modelId = route ? decodeURIComponent(route[1]) : null;
		const preferenceKey = preferenceRoute
			? decodeURIComponent(preferenceRoute[1])
			: null;
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const body = requestBody(init);
		calls.push({ body, method, path: url.pathname });
		if (failure && failure.method === method && failure.path === url.pathname) {
			const current = failure;
			failure = null;
			return jsonResponse({ error: current.message }, current.status);
		}
		if (method === "GET") {
			if (holdNextRead) {
				holdNextRead = false;
				await new Promise<void>((resolve) => {
					releaseRead = resolve;
				});
			}
			const current = readConfigs();
			return preferenceKey
				? jsonResponse({ value: current.preferences[preferenceKey] ?? null })
				: jsonResponse(current.configs[modelId ?? ""] ?? {});
		}
		if (method === "PUT") {
			const current = readConfigs();
			if (preferenceKey) {
				const parsedPreference = z
					.object({ value: z.string() })
					.safeParse(body);
				const value = parsedPreference.success
					? parsedPreference.data.value
					: undefined;
				if (!isNativeText(value)) {
					return jsonResponse({ error: "preference_value_required" }, 400);
				}
				current.preferences[preferenceKey] = value;
				writeConfigs(current);
				return jsonResponse({ ok: true });
			}
			const value = launchConfigSchema.parse(body);
			current.configs[modelId ?? ""] = value;
			writeConfigs(current);
			return jsonResponse(value);
		}
		return jsonResponse({ error: "fixture_method_not_allowed" }, 405);
	};
	return calls;
}

const NODE = {
	name: "model-launch-proof",
	url: window.location.origin,
	token: null,
	userJwt: null,
};
useNodeStore.setState({
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
installFixture();

function ProofSurface() {
	const [profile, setProfile] = useState(MODEL_ALPHA);
	const engineId = profile.startsWith("engine:")
		? profile.slice("engine:".length)
		: undefined;
	const modelId = engineId ? undefined : profile;
	const labels = new Map(
		Object.entries({
			[MODEL_ALPHA]: "Model Alpha · Q4",
			[MODEL_BETA]: "Model Beta · Q5",
			"engine:lemonade": "Lemonade · external runtime",
			"engine:llamacpp": "llama.cpp · engine defaults",
			"engine:ollama": "Ollama · engine defaults",
			"engine:sglang": "SGLang · engine defaults",
			"engine:vllm": "vLLM · engine defaults",
		})
	);
	const label = labels.get(profile) ?? profile;
	return (
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<I18nDirectionProvider>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-8">
							<div className="mx-auto max-w-4xl space-y-5">
								<header className="rounded-2xl border bg-card p-5 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Production ModelLaunchConfigSection proof
									</p>
									<h1 className="mt-1 font-semibold text-2xl">
										Engine launch settings
									</h1>
									<label
										className="mt-3 flex items-center gap-2 text-sm"
										htmlFor="model-profile"
									>
										<span>Model profile fixture</span>
										<select
											className="rounded-md border bg-background px-3 py-2"
											id="model-profile"
											onChange={(event) => setProfile(event.target.value)}
											value={profile}
										>
											<option value={MODEL_ALPHA}>Model Alpha · Q4</option>
											<option value={MODEL_BETA}>Model Beta · Q5</option>
											<option value="engine:llamacpp">
												llama.cpp · engine defaults
											</option>
											<option value="engine:ollama">
												Ollama · engine defaults
											</option>
											<option value="engine:vllm">
												vLLM · engine defaults
											</option>
											<option value="engine:sglang">
												SGLang · engine defaults
											</option>
											<option value="engine:lemonade">
												Lemonade · external runtime
											</option>
										</select>
									</label>
								</header>
								<ModelLaunchConfigSection
									engineId={engineId}
									launchAdapterSupported={engineId !== "lemonade"}
									modelId={modelId}
									subtitle={label}
									subtitleTitle={`Active launch config: ${engineId ?? modelId}`}
								/>
							</div>
						</main>
					</ThemeProvider>
				</I18nDirectionProvider>
			</I18nProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Model launch proof root not found");
}
const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});
createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
