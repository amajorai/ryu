import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { MemoryCategory, MemoryScope } from "../../src/lib/api/memory.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import LibraryPage from "../../src/pages/LibraryPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const memoryInputSchema = z.object({
	content: z.string().optional(),
	category: z
		.enum([
			"user_fact",
			"preference",
			"domain_knowledge",
			"organization",
			"project_context",
			"relationship",
			"directive",
			"procedure",
			"event",
			"other",
		])
		.optional(),
	scope: z.enum(["agent", "user", "node", "project", "org"]).optional(),
	scope_id: z.string().nullable().optional(),
	importance: z.number().optional(),
	tags: z.array(z.string()).optional(),
	when_to_use: z.string().nullable().optional(),
});

const API_BASE = "http://127.0.0.1:7975";
const MEMORY_ROWS_KEY = "memory-library-proof-rows";
const MEMORY_GIT_ROOT_KEY = "ryu.memory.git-root.v1";
const CONTRACT_FAILURES_KEY = "memory-library-proof-contract-failures";
const ENTITLEMENT_PREFERENCES_KEY =
	"memory-library-proof-entitlement-preferences";
const EXPECTED_ENTITLEMENT_PREFERENCES = new Map<string, string>([
	["entitlement-active", "true"],
	["managed-inference-entitled", "false"],
]);
const NODE = {
	managed: false,
	name: "memory-library-proof",
	orgId: null,
	token: "memory-library-proof-token",
	url: API_BASE,
	userJwt: null,
};

interface MemoryFixtureRow {
	author_agent_id: string | null;
	category: MemoryCategory;
	content: string;
	created_at: number;
	id: string;
	importance: number;
	scope: MemoryScope;
	scope_id: string | null;
	sensitive_topics: string[];
	tags: string[];
	updated_at: number;
	when_to_use: string | null;
}

interface CapturedRequest {
	auth: string | null;
	body: unknown;
	method: string;
	origin: string;
	path: string;
	status: number | null;
}

interface MemoryLibrarySnapshot {
	memories: MemoryFixtureRow[];
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	unexpected: string[];
}

interface MemoryLibraryProofState {
	armFailure: (method: string, path: string, status?: number) => void;
	snapshot: () => MemoryLibrarySnapshot;
}

declare global {
	interface Window {
		__memoryLibraryProof: MemoryLibraryProofState;
	}
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

function readRows(): MemoryFixtureRow[] {
	try {
		const value = localStorage.getItem(MEMORY_ROWS_KEY);
		// SAFETY: This proof-private key is written only by writeRows with MemoryFixtureRow arrays; parse failures retain the initialRows fallback.
		return value === null
			? initialRows()
			: (JSON.parse(value) as MemoryFixtureRow[]);
	} catch {
		return initialRows();
	}
}

function writeRows(rows: MemoryFixtureRow[]): void {
	localStorage.setItem(MEMORY_ROWS_KEY, JSON.stringify(rows));
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function row(input: {
	category?: MemoryCategory;
	content: string;
	id: string;
	importance?: number;
	scope?: MemoryScope;
	scopeId?: string | null;
	tags?: string[];
	whenToUse?: string | null;
}): MemoryFixtureRow {
	return {
		author_agent_id: null,
		category: input.category ?? "user_fact",
		content: input.content,
		created_at: 1_800_000_000_000,
		id: input.id,
		importance: input.importance ?? 3,
		scope: input.scope ?? "user",
		scope_id: input.scopeId ?? null,
		sensitive_topics: [],
		tags: input.tags ?? [],
		updated_at: 1_800_000_000_000,
		when_to_use: input.whenToUse ?? null,
	};
}

function initialRows(): MemoryFixtureRow[] {
	return [
		row({
			category: "preference",
			content: "Prefers concise code reviews",
			id: "memory-concise-reviews",
			importance: 4,
			tags: ["work", "planning"],
			whenToUse: "When reviewing a pull request",
		}),
		row({
			category: "project_context",
			content: "Project Atlas ships on Fridays",
			id: "memory-atlas-release",
			scope: "project",
			scopeId: "atlas",
			tags: ["atlas", "release"],
			whenToUse: "When planning an Atlas release",
		}),
		row({
			category: "user_fact",
			content: "Lives near a coastal city",
			id: "memory-coastal-city",
			tags: ["personal"],
		}),
	];
}

function installFixture(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		sessionStorage.removeItem(CONTRACT_FAILURES_KEY);
		sessionStorage.removeItem(ENTITLEMENT_PREFERENCES_KEY);
		localStorage.removeItem(MEMORY_ROWS_KEY);
		localStorage.removeItem(MEMORY_GIT_ROOT_KEY);
		params.delete("reset");
		const query = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query ? `?${query}` : ""}`
		);
	}
	if (!localStorage.getItem(MEMORY_ROWS_KEY)) {
		writeRows(params.get("empty") === "true" ? [] : initialRows());
	}

	const failures = new Map<string, number>();
	if (params.get("fail-list-once") === "true") {
		failures.set("GET /api/memory", 503);
	}
	const requests: CapturedRequest[] = [];
	// Keep failures across reload readback, so an earlier bad call cannot disappear
	// when a test validates its final persisted state.
	const unexpected: string[] = JSON.parse(
		sessionStorage.getItem(CONTRACT_FAILURES_KEY) ?? "[]"
	);
	const failContract = (reason: string) => {
		unexpected.push(reason);
		sessionStorage.setItem(CONTRACT_FAILURES_KEY, JSON.stringify(unexpected));
	};
	window.__memoryLibraryProof = {
		armFailure: (method, path, status = 503) => {
			failures.set(
				`${method.toUpperCase()} ${decodeURIComponent(path)}`,
				status
			);
		},
		snapshot: () => ({
			memories: structuredClone(readRows()),
			preferences: JSON.parse(
				sessionStorage.getItem(ENTITLEMENT_PREFERENCES_KEY) ?? "{}"
			),
			requests: structuredClone(requests),
			unexpected: [...unexpected],
		}),
	};

	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async () => undefined,
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs the exact complete private kernel constructed above.
	// This mutation view owns that two-method fixture slot, not the public Tauri SDK result ABI.
	(
		tauriWindow as Omit<typeof window, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : null;
		const rawUrl = isNativeText(input)
			? input
			: input instanceof URL
				? input.toString()
				: (request?.url ?? input.toString());
		const url = new URL(rawUrl, window.location.href);
		const path = decodeURIComponent(url.pathname);
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		const auth = new Headers(init?.headers ?? request?.headers).get(
			"authorization"
		);
		const record: CapturedRequest = {
			auth,
			body,
			method,
			origin: url.origin,
			path,
			status: null,
		};
		if (path.startsWith("/api/")) {
			requests.push(record);
			const memoryId = path.match(/^\/api\/memory\/([^/]+)$/)?.[1];
			const entitlementKey = path.match(/^\/api\/preferences\/([^/]+)$/)?.[1];
			const entitlementWrite =
				method === "PUT" &&
				entitlementKey !== undefined &&
				EXPECTED_ENTITLEMENT_PREFERENCES.has(entitlementKey);
			const known =
				entitlementWrite ||
				(path === "/api/preferences/memory.git-root" && method === "GET") ||
				(path === "/api/memory" && ["GET", "POST"].includes(method)) ||
				(path === "/api/memory/graph" && method === "GET") ||
				(memoryId !== undefined &&
					memoryId !== "graph" &&
					["PUT", "DELETE"].includes(method));
			if (
				!known ||
				url.origin !== API_BASE ||
				auth !== `Bearer ${NODE.token}` ||
				(["GET", "DELETE"].includes(method) && body !== null)
			) {
				failContract(
					`${method} ${url.origin}${path}: ${known ? (url.origin === API_BASE ? (auth === `Bearer ${NODE.token}` ? "unexpected request body" : "wrong node authorization") : "wrong node origin") : "unknown API"}`
				);
				record.status = 501;
				return json({ error: "Memory fixture request contract refused" }, 501);
			}
			if (entitlementWrite) {
				// useEntitlement synchronizes these two flags for this unmanaged,
				// signed-out fixture. The raw boolean string is the Core contract.
				const entitlementBody = z
					.object({ value: z.string() })
					.strict()
					.safeParse(body);
				if (
					!entitlementBody.success ||
					entitlementBody.data.value !==
						EXPECTED_ENTITLEMENT_PREFERENCES.get(entitlementKey)
				) {
					failContract(`${method} ${path}: unexpected entitlement payload`);
					record.status = 501;
					return json({ error: "Entitlement fixture payload refused" }, 501);
				}
				const preferences = z
					.record(z.string(), z.string())
					.parse(
						JSON.parse(
							sessionStorage.getItem(ENTITLEMENT_PREFERENCES_KEY) ?? "{}"
						)
					);
				preferences[entitlementKey] = entitlementBody.data.value;
				sessionStorage.setItem(
					ENTITLEMENT_PREFERENCES_KEY,
					JSON.stringify(preferences)
				);
				record.status = 200;
				return json({ ok: true, key: entitlementKey });
			}
		}
		const failureKey = `${method} ${path}`;
		const failureStatus = failures.get(failureKey);
		if (failureStatus !== undefined) {
			failures.delete(failureKey);
			record.status = failureStatus;
			return json({ error: "Fixture temporarily unavailable" }, failureStatus);
		}

		if (path === "/api/preferences/memory.git-root" && method === "GET") {
			record.status = 200;
			return json({ key: "memory.git-root", value: null });
		}
		if (path === "/api/memory" && method === "GET") {
			record.status = 200;
			return json({ memories: readRows() });
		}
		if (path === "/api/memory" && method === "POST") {
			const input = memoryInputSchema.parse(body);
			const memories = readRows();
			const created = row({
				category:
					/* SAFETY: The owned createMemory client serializes MemoryCreate.category from the shared MemoryCategory union, preserving absence. */ input.category as
						| MemoryCategory
						| undefined,
				content: String(input.content ?? ""),
				id: `memory-created-${memories.length + 1}`,
				importance:
					/* SAFETY: The owned createMemory client serializes MemoryCreate.importance as number or omits it. */ input.importance as
						| number
						| undefined,
				scope:
					/* SAFETY: The owned createMemory client serializes MemoryCreate.scope from the shared MemoryScope union, preserving absence. */ input.scope as
						| MemoryScope
						| undefined,
				scopeId:
					/* SAFETY: The owned createMemory client serializes scope_id from MemoryCreate.scopeId, which is string, null or absent. */ (input.scope_id as
						| string
						| undefined) ?? null,
				tags: /* SAFETY: The owned createMemory client serializes MemoryCreate.tags as string[] or omits it. */ input.tags as
					| string[]
					| undefined,
				whenToUse:
					/* SAFETY: The owned createMemory client serializes when_to_use from MemoryCreate.whenToUse, which is string, null or absent. */ (input.when_to_use as
						| string
						| undefined) ?? null,
			});
			memories.unshift(created);
			writeRows(memories);
			record.status = 201;
			return json({ memory: created }, 201);
		}
		if (path === "/api/memory/graph" && method === "GET") {
			record.status = 200;
			return json({
				edges: [],
				memory_count: readRows().length,
				nodes: [],
				truncated: false,
			});
		}
		const memoryId = path.match(/^\/api\/memory\/([^/]+)$/)?.[1];
		if (memoryId && method === "PUT") {
			const memories = readRows();
			const index = memories.findIndex((memory) => memory.id === memoryId);
			if (index < 0) {
				record.status = 404;
				return json({ error: "Memory was not found" }, 404);
			}
			const patch = memoryInputSchema.parse(body);
			const current = memories[index];
			const updated: MemoryFixtureRow = {
				...current,
				...(isNativeText(patch.content)
					? { content: patch.content }
					: undefined),
				...(isNativeText(patch.scope)
					? {
							scope:
								/* SAFETY: The owned updateMemory caller supplies the shared MemoryScope union; the native string check also excludes absent values here. */ patch.scope as MemoryScope,
						}
					: undefined),
				...(Object.hasOwn(patch, "scope_id")
					? {
							scope_id:
								/* SAFETY: The owned updateMemory client serializes scope_id from its nullable string scopeId; the presence check preserves explicit clears. */ (patch.scope_id as
									| string
									| null) ?? null,
						}
					: undefined),
				...(isNativeText(patch.category)
					? {
							category:
								/* SAFETY: The owned updateMemory caller supplies the shared MemoryCategory union; the native string check excludes absent values here. */ patch.category as MemoryCategory,
						}
					: undefined),
				...(isNativeNumber(patch.importance)
					? { importance: patch.importance }
					: undefined),
				...(Object.hasOwn(patch, "when_to_use")
					? {
							when_to_use:
								/* SAFETY: The owned updateMemory client serializes when_to_use from its nullable string whenToUse; presence preserves explicit clears. */ (patch.when_to_use as
									| string
									| null) ?? null,
						}
					: undefined),
				...(Array.isArray(patch.tags)
					? {
							tags: /* SAFETY: The owned updateMemory caller serializes string[] tags; Array.isArray additionally admits the present array before assignment. */ patch.tags as string[],
						}
					: undefined),
				updated_at: current.updated_at + 1,
			};
			memories[index] = updated;
			writeRows(memories);
			record.status = 200;
			return json({ memory: updated });
		}
		if (memoryId && method === "DELETE") {
			const memories = readRows();
			const next = memories.filter((memory) => memory.id !== memoryId);
			writeRows(next);
			record.status = 200;
			return json({ removed: next.length !== memories.length });
		}
		if (path.startsWith("/api/")) {
			failContract(
				`${method} ${url.origin}${path}: missing explicit API response`
			);
			record.status = 404;
			return json({ error: `Unhandled fixture API: ${method} ${path}` }, 404);
		}
		record.status = 404;
		return json(
			{ error: `Unexpected fixture request: ${method} ${path}` },
			404
		);
	};
}

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<MemoryRouter initialEntries={["/library/memory"]}>
						<main className="h-screen min-h-[900px] bg-background text-foreground">
							<Routes>
								<Route
									element={<LibraryPage initialSection="memory" />}
									path="/library/memory"
								/>
							</Routes>
						</main>
					</MemoryRouter>
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
setInterfaceLevel("expert");
installFixture();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<ProofSurface />
			</I18nProvider>
		</QueryClientProvider>
	);
}
