import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { getEditorAiConfig, setEditorAiConfig } from "@ryu/ui/lib/editor-ai.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { EditorEmbeddingSettings } from "../../src/components/settings/EditorEmbeddingSettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const API_BASE = "http://127.0.0.1:7973";
const PREFS_KEY = "editor-embedding-proof-preferences";
const MODEL_KEY = "editor-embedding-proof-model";
const STATUS_KEY = "editor-embedding-proof-status";
const REQUESTS_KEY = "editor-embedding-proof-requests";

const NODE = {
	managed: false,
	name: "editor-embedding-proof-node",
	orgId: null,
	token: "editor-embedding-proof-node-token",
	url: API_BASE,
	userJwt: "editor-embedding-proof-user-jwt",
};

interface EmbeddingModelWire {
	base_url: string;
	dims: number;
	model_id: string;
}

interface ReindexStatusWire {
	current_dims: number;
	current_model: string;
	pending_chunks: number;
	running: boolean;
	total_chunks: number;
}

interface CapturedRequest {
	body: unknown;
	headers: {
		authorization: string | null;
		userJwt: string | null;
	};
	method: string;
	path: string;
	status: number;
}

interface EditorEmbeddingProofSnapshot {
	editorAi: ReturnType<typeof getEditorAiConfig>;
	embeddingModel: EmbeddingModelWire;
	preferences: Record<string, string>;
	reindexStatus: ReindexStatusWire;
	requests: CapturedRequest[];
}

declare global {
	interface Window {
		__editorEmbeddingSettingsProof: {
			armFailure: (method: string, path: string, status?: number) => void;
			queueStatusReads: (statuses: ReindexStatusWire[]) => void;
			snapshot: () => EditorEmbeddingProofSnapshot;
		};
	}
}

const DEFAULT_MODEL: EmbeddingModelWire = {
	base_url: "http://127.0.0.1:8081",
	dims: 768,
	model_id: "nomic-embed-text-v1.5",
};

const DEFAULT_STATUS: ReindexStatusWire = {
	current_dims: 768,
	current_model: "nomic-embed-text-v1.5",
	pending_chunks: 0,
	running: false,
	total_chunks: 8,
};

const AGENTS = [
	{
		id: "agent-writer",
		lifecycle_status: "ready",
		model: "writer-model-v3",
		name: "Writer Agent",
	},
	{
		id: "agent-no-model",
		lifecycle_status: "ready",
		model: null,
		name: "No Model Agent",
	},
];

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

const embeddingModelSchema = z.object({
	base_url: z.string(),
	dims: z.number(),
	model_id: z.string(),
});
const reindexStatusSchema = z.object({
	current_dims: z.number(),
	current_model: z.string(),
	pending_chunks: z.number(),
	running: z.boolean(),
	total_chunks: z.number(),
});
const capturedRequestSchema = z.object({
	body: z.json().optional(),
	headers: z.object({
		authorization: z.string().nullable(),
		userJwt: z.string().nullable(),
	}),
	method: z.string(),
	path: z.string(),
	status: z.number(),
});
function readObject<T>(key: string, fallback: T, schema: z.ZodType<T>): T {
	try {
		const stored = localStorage.getItem(key);
		return stored === null ? fallback : schema.parse(JSON.parse(stored));
	} catch {
		return fallback;
	}
}

function writeObject<FixturePayload>(key: string, value: FixturePayload): void {
	localStorage.setItem(key, JSON.stringify(value));
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function cleanProofQuery(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		for (const key of [PREFS_KEY, MODEL_KEY, STATUS_KEY, REQUESTS_KEY]) {
			localStorage.removeItem(key);
		}
	}
	params.delete("reset");
	params.delete("failInitialReads");
	params.delete("staleInitial");
	const query = params.toString();
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}${query ? `?${query}` : ""}`
	);
}

function installFixture(): void {
	const params = new URLSearchParams(window.location.search);
	cleanProofQuery();
	let preferences = readObject<Record<string, string>>(
		PREFS_KEY,
		{},
		z.record(z.string(), z.string())
	);
	let embeddingModel = readObject<EmbeddingModelWire>(
		MODEL_KEY,
		DEFAULT_MODEL,
		embeddingModelSchema
	);
	let reindexStatus = readObject<ReindexStatusWire>(
		STATUS_KEY,
		params.get("staleInitial") === "true"
			? { ...DEFAULT_STATUS, pending_chunks: 3 }
			: DEFAULT_STATUS,
		reindexStatusSchema
	);
	const requests = readObject<CapturedRequest[]>(
		REQUESTS_KEY,
		[],
		z.array(capturedRequestSchema)
	);
	const failures = new Map<string, number>();
	let queuedStatusReads: ReindexStatusWire[] = [];
	if (params.get("failInitialReads") === "true") {
		for (const path of [
			"/api/preferences/editor-ai",
			"/api/embeddings/model",
			"/api/embeddings/reindex/status",
		]) {
			failures.set(`GET ${path}`, 503);
		}
	}

	window.__editorEmbeddingSettingsProof = {
		armFailure: (method, path, status = 503) => {
			failures.set(`${method.toUpperCase()} ${path}`, status);
		},
		queueStatusReads: (statuses) => {
			queuedStatusReads = [...statuses];
		},
		snapshot: () => ({
			editorAi: structuredClone(getEditorAiConfig()),
			embeddingModel: structuredClone(embeddingModel),
			preferences: structuredClone(preferences),
			requests: structuredClone(requests),
			reindexStatus: structuredClone(reindexStatus),
		}),
	};

	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : null;
		const rawUrl = isNativeText(input)
			? input
			: input instanceof URL
				? input.toString()
				: (request?.url ?? input.toString());
		const url = new URL(rawUrl, window.location.href);
		if (!url.pathname.startsWith("/api/")) {
			return await nativeFetch(input, init);
		}

		const path = decodeURIComponent(url.pathname);
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const headers = new Headers(request?.headers);
		new Headers(init?.headers).forEach((value, name) =>
			headers.set(name, value)
		);
		let body: ProofJsonValue = null;
		if (isNativeText(init?.body)) {
			try {
				body = parseProofJson(init.body);
			} catch {
				body = init.body;
			}
		}
		const requestRecord: CapturedRequest = {
			body,
			headers: {
				authorization: headers.get("authorization"),
				userJwt: headers.get("x-ryu-user-jwt"),
			},
			method,
			path,
			status: 0,
		};
		requests.push(requestRecord);
		writeObject(REQUESTS_KEY, requests);

		const failureKey = `${method} ${path}`;
		const failureStatus = failures.get(failureKey);
		if (failureStatus !== undefined) {
			failures.delete(failureKey);
			requestRecord.status = failureStatus;
			writeObject(REQUESTS_KEY, requests);
			return json({ error: "editor_embedding_fixture_failure" }, failureStatus);
		}

		if (path === "/api/preferences/editor-ai") {
			if (method === "PUT") {
				const parsedPreference = z
					.object({ value: z.string() })
					.safeParse(body);
				if (!parsedPreference.success) {
					requestRecord.status = 400;
					return json({ error: "invalid_preference_payload" }, 400);
				}
				const { value } = parsedPreference.data;
				preferences = { ...preferences, "editor-ai": value };
				writeObject(PREFS_KEY, preferences);
				requestRecord.status = 200;
				writeObject(REQUESTS_KEY, requests);
				return json({ key: "editor-ai", ok: true, value });
			}
			const value = preferences["editor-ai"];
			if (value === undefined) {
				requestRecord.status = 404;
				writeObject(REQUESTS_KEY, requests);
				return json({ error: "not_found" }, 404);
			}
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			return json({ key: "editor-ai", value });
		}
		if (path === "/api/agents") {
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			return json({ agents: AGENTS });
		}
		if (path === "/api/engines") {
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			return json({ engines: [] });
		}
		if (path === "/api/engine/active" || path === "/api/engines/active") {
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			return json({
				active: null,
				available: [],
				llamacpp_variant: null,
				running: false,
			});
		}
		if (path === "/api/embeddings/model") {
			if (method === "POST") {
				const input = embeddingModelSchema.partial().parse(body ?? {});
				if (!input.model_id?.trim()) {
					requestRecord.status = 400;
					return json({ error: "model_id is required" }, 400);
				}
				if (input.dims === 0) {
					requestRecord.status = 400;
					return json({ error: "dims must be greater than zero" }, 400);
				}
				embeddingModel = {
					base_url: input.base_url ?? "",
					dims: input.dims ?? embeddingModel.dims,
					model_id: input.model_id.trim(),
				};
				reindexStatus = {
					current_dims: embeddingModel.dims,
					current_model: embeddingModel.model_id,
					pending_chunks: reindexStatus.total_chunks,
					running: true,
					total_chunks: reindexStatus.total_chunks,
				};
				writeObject(MODEL_KEY, embeddingModel);
				writeObject(STATUS_KEY, reindexStatus);
				requestRecord.status = 200;
				writeObject(REQUESTS_KEY, requests);
				return json({ reindexing: true, success: true });
			}
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			// Core's GET serializes `EmbeddingModelInfo { model_id, dims }` and
			// never returns base_url, so the fixture serves that exact shape.
			return json({
				dims: embeddingModel.dims,
				model_id: embeddingModel.model_id,
			});
		}
		if (path === "/api/embeddings/reindex/status") {
			if (queuedStatusReads.length > 0) {
				reindexStatus = queuedStatusReads.shift() ?? reindexStatus;
				writeObject(STATUS_KEY, reindexStatus);
			}
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			return json(reindexStatus);
		}
		if (path === "/api/embeddings/reindex" && method === "POST") {
			reindexStatus = { ...reindexStatus, running: true };
			writeObject(STATUS_KEY, reindexStatus);
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			return json({ started: true });
		}
		if (path === "/api/auth/get-session") {
			requestRecord.status = 200;
			writeObject(REQUESTS_KEY, requests);
			return json({ session: null, user: null });
		}

		requestRecord.status = 404;
		writeObject(REQUESTS_KEY, requests);
		return json({ error: `Unhandled fixture API: ${method} ${path}` }, 404);
	};
}

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="mx-auto min-h-screen max-w-5xl space-y-6 bg-background p-8 text-foreground">
						<header>
							<p className="text-muted-foreground text-xs tracking-widest">
								RYU · EDITOR &amp; EMBEDDINGS PROOF
							</p>
							<h1 className="mt-2 font-semibold text-2xl">
								Editor &amp; Embeddings
							</h1>
							<p className="mt-2 text-muted-foreground text-sm">
								Production desktop settings component with isolated node,
								preference, embedding and reindex fixtures.
							</p>
						</header>
						<EditorEmbeddingSettings />
					</main>
					<Toaster position="bottom-right" theme="system" />
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
setEditorAiConfig({
	agentId: undefined,
	apiKey: undefined,
	baseUrl: null,
	enabled: false,
	model: "",
});
setInterfaceLevel("expert");
installFixture();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<ProofSurface />
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}
