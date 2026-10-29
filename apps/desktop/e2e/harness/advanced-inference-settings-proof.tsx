import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import {
	AgentSettingsForm,
	type AgentSettingsFormProps,
} from "../../../../packages/blocks/src/desktop/agent-edit.tsx";
import { AdvancedInferenceSection } from "../../src/components/inference/AdvancedInferenceSection.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import {
	type Agent,
	type AgentInput,
	fetchAgent,
	updateAgent,
} from "../../src/lib/api/agents.ts";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import {
	getEngineSamplingConfig,
	isLocalEngine,
	type SamplingConfig,
	saveEngineSamplingConfig,
} from "../../src/lib/api/inference.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const AGENT_ID = "advanced-inference-proof";
const STORAGE_KEY = "ryu:advanced-inference-proof:agent";
const ENGINE_PREFERENCE_STORAGE_PREFIX =
	"ryu:advanced-inference-proof:preference:";
const FIXTURE_TIME = "2026-09-27T00:00:00.000Z";
const TARGET: ApiTarget = {
	token: null,
	url: window.location.origin,
	userJwt: null,
};

interface AgentWire {
	built_in: boolean;
	chat_model: { engine: string | null; model_id: string | null };
	composio_actions: string[];
	created_at: string;
	description: string | null;
	engine: string;
	id: string;
	identity_profile_ids: string[];
	inference: SamplingConfig;
	lifecycle_status: string;
	locked: boolean;
	memory: {
		read_levels: string[];
		space_ids: string[];
		write_enabled: boolean;
	};
	model: string | null;
	name: string;
	orchestrator: boolean | null;
	persona: null;
	safety_profile: string;
	skills: string[];
	system_prompt: string | null;
	title: string;
	tools: string[];
	updated_at: string;
	version: string;
}

const samplingSchema = z.object({
	dry_allowed_length: z.number().optional(),
	dry_base: z.number().optional(),
	dry_multiplier: z.number().optional(),
	dry_penalty_last_n: z.number().optional(),
	dynatemp_exponent: z.number().optional(),
	dynatemp_range: z.number().optional(),
	frequency_penalty: z.number().optional(),
	max_tokens: z.number().optional(),
	min_p: z.number().optional(),
	mirostat: z.number().optional(),
	mirostat_eta: z.number().optional(),
	mirostat_tau: z.number().optional(),
	presence_penalty: z.number().optional(),
	repeat_last_n: z.number().optional(),
	repeat_penalty: z.number().optional(),
	seed: z.number().optional(),
	temperature: z.number().optional(),
	top_k: z.number().optional(),
	top_n_sigma: z.number().optional(),
	top_p: z.number().optional(),
	typical_p: z.number().optional(),
	xtc_probability: z.number().optional(),
	xtc_threshold: z.number().optional(),
	grammar: z.string().optional(),
	prefill: z.string().optional(),
	samplers: z.string().optional(),
	stop: z.array(z.string()).optional(),
	logit_bias: z.record(z.string(), z.number()).optional(),
	extra: z.record(z.string(), z.json()).optional(),
	response_format: z.record(z.string(), z.json()).optional(),
}) satisfies z.ZodType<SamplingConfig>;
const agentWireSchema = z.object({
	built_in: z.boolean(),
	locked: z.boolean(),
	created_at: z.string(),
	engine: z.string(),
	id: z.string(),
	lifecycle_status: z.string(),
	name: z.string(),
	safety_profile: z.string(),
	title: z.string(),
	updated_at: z.string(),
	version: z.string(),
	description: z.string().nullable(),
	model: z.string().nullable(),
	system_prompt: z.string().nullable(),
	composio_actions: z.array(z.string()),
	identity_profile_ids: z.array(z.string()),
	skills: z.array(z.string()),
	tools: z.array(z.string()),
	chat_model: z.object({
		engine: z.string().nullable(),
		model_id: z.string().nullable(),
	}),
	inference: samplingSchema,
	memory: z.object({
		read_levels: z.array(z.string()),
		space_ids: z.array(z.string()),
		write_enabled: z.boolean(),
	}),
	orchestrator: z.boolean().nullable(),
	persona: z.null(),
}) satisfies z.ZodType<AgentWire>;
const agentUpdateSchema = agentWireSchema
	.pick({
		name: true,
		title: true,
		description: true,
		engine: true,
		model: true,
		system_prompt: true,
		tools: true,
		inference: true,
	})
	.partial();
const preferenceWriteSchema = z.object({ value: z.string() });

interface ProofRequest {
	body: unknown;
	method: string;
	path: string;
}

interface ProofSnapshot {
	agent: AgentWire | null;
	calls: ProofRequest[];
	draft: SamplingConfig;
	preferences: Record<string, string>;
}

interface FailurePlan {
	message: string;
	method: string;
	path: string;
	status: number;
}

declare global {
	interface Window {
		__advancedInferenceProof: {
			calls: () => ProofRequest[];
			draft: () => SamplingConfig;
			failNext: (failure: FailurePlan) => void;
			snapshot: () => ProofSnapshot;
		};
	}
}

function localInitialInference(): SamplingConfig {
	return {
		dry_allowed_length: 3,
		dry_base: 1.7,
		dry_multiplier: 1.15,
		dry_penalty_last_n: 64,
		dynatemp_exponent: 1.3,
		dynatemp_range: 0.2,
		extra: { min_keep: 1 },
		frequency_penalty: 0.1,
		grammar: 'root ::= "yes" | "no"',
		logit_bias: { "42": -5 },
		max_tokens: 128,
		min_p: 0.05,
		mirostat: 1,
		mirostat_eta: 0.1,
		mirostat_tau: 5,
		prefill: "{\n",
		presence_penalty: 0.2,
		repeat_last_n: 48,
		repeat_penalty: 1.05,
		response_format: { type: "json_object" },
		samplers: "penalties;dry;top_k;top_p;min_p;temperature",
		seed: 41,
		stop: ["<END>"],
		temperature: 0.7,
		top_k: 40,
		top_n_sigma: 0.5,
		top_p: 0.85,
		typical_p: 0.8,
		xtc_probability: 0.1,
		xtc_threshold: 0.4,
	};
}

function initialAgent(): AgentWire {
	const params = new URLSearchParams(window.location.search);
	const engine = params.get("engine") === "remote" ? "acp:claude" : "ollama";
	return {
		built_in: false,
		chat_model: { engine, model_id: null },
		composio_actions: [],
		created_at: FIXTURE_TIME,
		description:
			"Exercise production sampling controls against a local fixture.",
		engine,
		id: AGENT_ID,
		identity_profile_ids: [],
		inference:
			engine === "ollama"
				? localInitialInference()
				: {
						frequency_penalty: 0,
						max_tokens: 256,
						prefill: "",
						presence_penalty: 0,
						response_format: { type: "json_object" },
						seed: 7,
						stop: [],
						temperature: 0.4,
						top_p: 0.9,
					},
		lifecycle_status: "active",
		locked: params.get("locked") === "true",
		memory: { read_levels: [], space_ids: [], write_enabled: false },
		model: null,
		name: "Inference test agent",
		orchestrator: true,
		persona: null,
		safety_profile: "autonomous",
		skills: [],
		system_prompt: "Answer clearly and use the saved sampling defaults.",
		title: "Inference",
		tools: [],
		updated_at: FIXTURE_TIME,
		version: "1.0.0",
	};
}

function readAgent(): AgentWire {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return agentWireSchema.parse(JSON.parse(stored));
		}
	} catch {
		// Invalid proof storage starts from an isolated known fixture.
	}
	const agent = initialAgent();
	localStorage.setItem(STORAGE_KEY, JSON.stringify(agent));
	return agent;
}

function enginePreferenceStorageKey(engineId: string): string {
	return `${ENGINE_PREFERENCE_STORAGE_PREFIX}inference.engine.${engineId}`;
}

function readEnginePreference(engineId: string): string {
	return (
		localStorage.getItem(enginePreferenceStorageKey(engineId)) ??
		JSON.stringify(localInitialInference())
	);
}

function enginePreferenceSnapshot(engineId: string) {
	return { [`inference.engine.${engineId}`]: readEnginePreference(engineId) };
}

function writeAgent<FixtureAgent>(agent: FixtureAgent): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(agent));
}

function jsonResponse<FixturePayload>(
	value: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function readRequestBody(init?: RequestInit) {
	if (!isNativeText(init?.body)) {
		return undefined;
	}
	try {
		return parseProofJson(init.body);
	} catch {
		return init.body;
	}
}

function installFixture(): ProofRequest[] {
	const calls: ProofRequest[] = [];
	let failure: FailurePlan | null = null;
	const engineId =
		new URLSearchParams(window.location.search).get("engine") ?? "ollama";
	const originalFetch = window.fetch.bind(window);
	window.__advancedInferenceProof = {
		calls: () => [...calls],
		draft: () => ({}),
		failNext: (nextFailure) => {
			failure = nextFailure;
		},
		snapshot: () => ({
			agent: readAgent(),
			calls: [...calls],
			draft: {},
			preferences: enginePreferenceSnapshot(engineId),
		}),
	};
	window.fetch = async (input, init) => {
		const url = new URL(
			input instanceof Request ? input.url : String(input),
			window.location.origin
		);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		if (url.pathname.startsWith("/api/preferences/")) {
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			const body = readRequestBody(init);
			calls.push({ body, method, path: url.pathname });
			if (
				failure &&
				failure.method === method &&
				failure.path === url.pathname
			) {
				const currentFailure = failure;
				failure = null;
				return jsonResponse(
					{ error: currentFailure.message },
					currentFailure.status
				);
			}
			if (key === `inference.engine.${engineId}` && method === "GET") {
				return jsonResponse({ key, value: readEnginePreference(engineId) });
			}
			if (key === `inference.engine.${engineId}` && method === "PUT") {
				const preference = preferenceWriteSchema.safeParse(body);
				if (!preference.success) {
					return jsonResponse(
						{ error: "Preference value must be a string." },
						400
					);
				}
				const { value } = preference.data;
				localStorage.setItem(enginePreferenceStorageKey(engineId), value);
				return jsonResponse({ key, value });
			}
			return jsonResponse({ error: "Unknown preference." }, 404);
		}
		if (url.pathname === `/api/agents/${AGENT_ID}`) {
			const body = readRequestBody(init);
			calls.push({ body, method, path: url.pathname });
			if (
				failure &&
				failure.method === method &&
				failure.path === url.pathname
			) {
				const currentFailure = failure;
				failure = null;
				return jsonResponse(
					{ error: currentFailure.message },
					currentFailure.status
				);
			}
			if (method === "GET") {
				return jsonResponse({ agent: readAgent() });
			}
			if (method === "PUT") {
				const previous = readAgent();
				const update = agentUpdateSchema.safeParse(body);
				if (!update.success) {
					return jsonResponse({ error: "Invalid agent update." }, 400);
				}
				const updated: AgentWire = {
					...previous,
					...update.data,
					updated_at: FIXTURE_TIME,
				};
				writeAgent(updated);
				return jsonResponse({ agent: updated });
			}
		}
		return originalFetch(input, init);
	};
	return calls;
}

const BASE_EDITOR_PROPS = {
	acpCommand: "",
	chatModel: "ollama",
	composioActions: [],
	composioConfigured: false,
	composioToolkit: null,
	composioToolkitItems: [],
	composioTriggers: [],
	connectedAccountId: "",
	customCron: "",
	customTone: "",
	dailyTime: "09:00",
	engineOptions: [{ id: "ollama", label: "Ollama" }],
	isBuiltIn: false,
	isLocked: false,
	isNew: false,
	memoryReadLevels: new Set<string>(),
	memorySpaceIds: new Set<string>(),
	memoryWriteEnabled: false,
	name: "Inference test agent",
	personaDisplayName: "",
	rules: [],
	scheduleEnabled: false,
	schedulePhrase: "daily",
	selectedComposio: new Set<string>(),
	selectedSkills: new Set<string>(),
	selectedTools: new Set<string>(),
	skills: [],
	spaces: [],
	systemPrompt: "Answer clearly and use the saved sampling defaults.",
	tone: "neutral",
	toneOptions: [{ label: "Neutral", value: "neutral" }],
	tools: [],
	triggerError: null,
	triggerSlug: "",
	triggerSubs: [],
	weeklyDay: "monday",
	weeklyTime: "09:00",
} satisfies AgentSettingsFormProps;

const requestCalls = installFixture();
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function ProofSurface() {
	const [agent, setAgent] = useState<Agent | null>(null);
	const [sampling, setSampling] = useState<SamplingConfig>({});
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveStatus, setSaveStatus] = useState(
		"Loading saved inference settings…"
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoadError(null);
		try {
			const loaded = await fetchAgent(TARGET, AGENT_ID);
			setAgent(loaded);
			setSampling(loaded.inference ?? {});
			setSaveStatus("Loaded from the agent record");
		} catch (error) {
			setLoadError(
				error instanceof Error ? error.message : "Could not load agent"
			);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);
	window.__advancedInferenceProof.draft = () => ({ ...sampling });
	window.__advancedInferenceProof.snapshot = () => ({
		agent: readAgent(),
		calls: requestCalls,
		draft: { ...sampling },
		preferences: enginePreferenceSnapshot(
			new URLSearchParams(window.location.search).get("engine") ?? "ollama"
		),
	});

	const handleSave = async () => {
		if (!agent) {
			return;
		}
		setSaving(true);
		setFormError(null);
		try {
			const input: AgentInput = {
				name: agent.name,
				title: agent.title,
				description: agent.description,
				engine: agent.engine,
				model: agent.model,
				systemPrompt: agent.systemPrompt,
				tools: agent.tools,
				inference: sampling,
			};
			const updated = await updateAgent(TARGET, AGENT_ID, input);
			setAgent(updated);
			setSampling(updated.inference ?? {});
			setSaveStatus("Saved to the agent record");
		} catch (error) {
			setFormError(
				error instanceof Error ? error.message : "Could not save agent"
			);
		} finally {
			setSaving(false);
		}
	};

	if (!agent) {
		return (
			<main className="min-h-dvh bg-background p-8 text-foreground">
				{loadError ? (
					<div role="alert">
						<p>{loadError}</p>
						<button onClick={() => void load()} type="button">
							Retry load
						</button>
					</div>
				) : (
					<p>{saveStatus}</p>
				)}
			</main>
		);
	}

	return (
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<I18nDirectionProvider>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-8">
							<div className="mx-auto max-w-5xl space-y-5">
								<header className="rounded-2xl border bg-card p-5 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Production AgentSettingsForm proof
									</p>
									<h1 className="mt-1 font-semibold text-2xl">
										Advanced inference
									</h1>
									<p
										className="mt-1 text-muted-foreground text-sm"
										data-testid="save-status"
									>
										{saveStatus}
									</p>
								</header>
								<AgentSettingsForm
									{...BASE_EDITOR_PROPS}
									advancedInference={
										<AdvancedInferenceSection
											disabled={agent.locked}
											localEngine={isLocalEngine(agent.engine)}
											onChange={setSampling}
											value={sampling}
										/>
									}
									chatModel={agent.engine ?? ""}
									engineOptions={
										agent.engine
											? [{ id: agent.engine, label: agent.engine }]
											: []
									}
									formError={formError}
									initialTab="advanced"
									isLocked={agent.locked}
									name={agent.name}
									onSave={() => void handleSave()}
									saveDisabled={saving || agent.locked}
									saving={saving}
								/>
								<Toaster position="bottom-right" theme="dark" />
							</div>
						</main>
					</ThemeProvider>
				</I18nDirectionProvider>
			</I18nProvider>
		</AppSurfaceProvider>
	);
}

function EngineSamplingDefaultsProof() {
	const engineId =
		new URLSearchParams(window.location.search).get("engine") ?? "ollama";
	const [sampling, setSampling] = useState<SamplingConfig>({});
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void getEngineSamplingConfig(TARGET, engineId)
			.then((config) => {
				if (active) {
					setSampling(config);
					setLoadError(null);
				}
			})
			.catch((error) => {
				if (active) {
					setLoadError(
						error instanceof Error
							? error.message
							: "Could not load engine sampling defaults"
					);
				}
			})
			.finally(() => {
				if (active) {
					setLoaded(true);
				}
			});
		return () => {
			active = false;
		};
	}, [engineId]);

	window.__advancedInferenceProof.draft = () => ({ ...sampling });
	window.__advancedInferenceProof.snapshot = () => ({
		agent: readAgent(),
		calls: requestCalls,
		draft: { ...sampling },
		preferences: enginePreferenceSnapshot(engineId),
	});

	const handleSave = async () => {
		setSaving(true);
		setSaved(false);
		setSaveError(null);
		try {
			await saveEngineSamplingConfig(TARGET, engineId, sampling);
			setSaved(true);
		} catch (error) {
			setSaveError(
				error instanceof Error
					? error.message
					: "Could not save engine sampling defaults"
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<I18nDirectionProvider>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-8">
							<div className="mx-auto max-w-5xl space-y-5">
								<header className="rounded-2xl border bg-card p-5 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Production AdvancedInferenceSection proof
									</p>
									<h1 className="mt-1 font-semibold text-2xl">
										{engineId} sampling defaults
									</h1>
									<p
										className="mt-1 text-muted-foreground text-sm"
										data-testid="save-status"
									>
										{loadError ??
											(saved
												? "Saved for this engine"
												: loaded
													? "Loaded engine sampling defaults"
													: "Loading engine sampling defaults…")}
									</p>
								</header>
								{loadError ? (
									<p role="alert">{loadError}</p>
								) : loaded ? (
									<AdvancedInferenceSection
										engineId={engineId}
										localEngine={false}
										onChange={setSampling}
										onSave={() => void handleSave()}
										saved={saved}
										saveError={saveError}
										saving={saving}
										scope="engine"
										value={sampling}
									/>
								) : null}
								<Toaster position="bottom-right" theme="dark" />
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
	throw new Error("Advanced inference proof root not found");
}
createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<MemoryRouter>
			{new URLSearchParams(window.location.search).get("scope") === "engine" ? (
				<EngineSamplingDefaultsProof />
			) : (
				<ProofSurface />
			)}
		</MemoryRouter>
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
