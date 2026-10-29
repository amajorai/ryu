import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import {
	BrowserTabPanel,
	PanelToggleButtons,
} from "../../src/components/panels/WorkspacePanels.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { AppInfo } from "../../src/lib/api/plugins.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import { useAssistantStore } from "../../src/store/useAssistantStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const NODE = {
	name: "workspace-browser-proof",
	token: "workspace-browser-proof-token",
	url: "http://127.0.0.1:7993",
	userJwt: null,
};
const BROWSER_APP: AppInfo = {
	approvedGrants: [],
	builtIn: false,
	category: null,
	channel: null,
	companion: null,
	description: "Local proof app roster entry.",
	enabled: true,
	external: false,
	icon: null,
	iconBackground: null,
	iconDither: null,
	iconPadding: null,
	iconUrl: null,
	id: "@ryu/browser",
	installed: true,
	installedVersion: "1.0.0",
	layers: [],
	localOnly: true,
	mandatory: false,
	mcpOAuthServers: [],
	name: "Browser",
	permissionGrants: [],
	requires: null,
	runnables: [],
	sidecarName: "browser",
	stability: null,
	suppressedBySafeMode: false,
	surfaceSupport: [],
	tagline: "Local browser fixture",
	targets: ["desktop"],
	tier: null,
	version: "1.0.0",
	windowsFirst: false,
};
const STORAGE_KEY = "browser-annotations-caller-proof-state";
const BROWSER_API = "/api/ext/@ryu/browser";
const INITIAL_TAB = {
	id: "browser-proof-start",
	title: "Workspace start page",
	url: "https://workspace.example.test/start",
};
const TARGET = {
	attributes: { class: "primary-action", type: "button" },
	computed_styles: {
		backgroundColor: "rgb(37, 99, 235)",
		color: "rgb(255, 255, 255)",
		fontSize: "16px",
	},
	component: "WorkspaceFixture",
	content_preview: "Open project",
	name: "Open project",
	rect: { height: 48, width: 176, x: 132, y: 352 },
	role: "button",
	selector: "main .primary-action",
	tag: "button",
	text: "Open project",
	xpath: "/html/body/main/button[1]",
};
const FIXTURE_PNG = createFixtureScreenshot();

interface FixtureTab {
	id: string;
	title: string;
	url: string;
}

/** Exact locally copied fixture response fields; opaque inputs are retained,
 * including native inherited properties, rather than asserted as production annotations. */
interface FixtureAnnotationTransportObservation {
	comment?: unknown;
	created_at: string;
	id: string;
	kind?: unknown;
	rect?: unknown;
	style?: unknown;
	targets: (typeof TARGET)[];
}

interface CapturedRequest {
	authorization: string | null;
	body: unknown;
	contentType: string | null;
	method: string;
	path: string;
	status: number | null;
}

interface BrowserProofSnapshot {
	annotations: Record<string, FixtureAnnotationTransportObservation[]>;
	assistant: { mode: string; pendingPrompt: string | null };
	requests: CapturedRequest[];
	tabs: FixtureTab[];
	unexpectedRoutes: string[];
}

interface BrowserProofState {
	armNextFailure: (method: string, path: string) => void;
	delayNextContext: () => void;
	snapshot: () => BrowserProofSnapshot;
}

declare global {
	interface Window {
		__browserAnnotationsCallerProof: BrowserProofState;
	}
}

interface PersistedFixture {
	annotations: Record<string, FixtureAnnotationTransportObservation[]>;
	tabs: FixtureTab[];
}

function createFixtureScreenshot(): string {
	const canvas = document.createElement("canvas");
	canvas.width = 1440;
	canvas.height = 900;
	const context = canvas.getContext("2d");
	if (!context) {
		return "";
	}
	context.fillStyle = "#f8fafc";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.fillStyle = "#ffffff";
	context.fillRect(0, 0, canvas.width, 82);
	context.strokeStyle = "#e2e8f0";
	context.beginPath();
	context.moveTo(0, 82);
	context.lineTo(canvas.width, 82);
	context.stroke();
	context.fillStyle = "#0f172a";
	context.font = "700 30px Arial, sans-serif";
	context.fillText("Workspace preview", 72, 53);
	context.fillStyle = "#64748b";
	context.font = "18px Arial, sans-serif";
	context.fillText("Local browser-sidecar fixture · no external page", 72, 126);
	context.fillStyle = "#ffffff";
	context.strokeStyle = "#cbd5e1";
	context.lineWidth = 2;
	context.beginPath();
	context.roundRect(72, 170, 1056, 480, 24);
	context.fill();
	context.stroke();
	context.fillStyle = "#0f172a";
	context.font = "700 46px Arial, sans-serif";
	context.fillText("Your project, ready.", 132, 284);
	context.fillStyle = "#475569";
	context.font = "22px Arial, sans-serif";
	context.fillText(
		"Review this workspace and leave focused feedback.",
		132,
		332
	);
	context.fillStyle = "#2563eb";
	context.beginPath();
	context.roundRect(
		TARGET.rect.x,
		TARGET.rect.y,
		TARGET.rect.width,
		TARGET.rect.height,
		12
	);
	context.fill();
	context.fillStyle = "#ffffff";
	context.font = "600 18px Arial, sans-serif";
	context.fillText("Open project", 162, 382);
	context.fillStyle = "#e0e7ff";
	context.beginPath();
	context.roundRect(660, 235, 410, 260, 18);
	context.fill();
	context.fillStyle = "#c7d2fe";
	context.beginPath();
	context.roundRect(706, 282, 318, 22, 11);
	context.fill();
	context.beginPath();
	context.roundRect(706, 332, 246, 18, 9);
	context.fill();
	context.beginPath();
	context.roundRect(706, 378, 282, 18, 9);
	context.fill();
	return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

const rectSchema = z
	.object({
		height: z.number(),
		width: z.number(),
		x: z.number(),
		y: z.number(),
	})
	.catchall(z.json());
const annotationInputSchema = z
	.object({
		comment: z.json().optional(),
		kind: z.json().optional(),
		rect: z.json().optional(),
		selections: z.json().optional(),
		style: z.json().optional(),
	})
	.catchall(z.json());
const targetSchema = z.object({
	attributes: z.object({ class: z.string(), type: z.string() }),
	computed_styles: z.object({
		backgroundColor: z.string(),
		color: z.string(),
		fontSize: z.string(),
	}),
	component: z.string(),
	content_preview: z.string(),
	name: z.string(),
	rect: rectSchema,
	role: z.string(),
	selector: z.string(),
	tag: z.string(),
	text: z.string(),
	xpath: z.string(),
});
const persistedFixtureSchema = z.object({
	annotations: z.record(
		z.string(),
		annotationInputSchema
			.extend({
				created_at: z.string(),
				id: z.string(),
				targets: z.array(targetSchema),
			})
			.array()
	),
	tabs: z.array(
		z.object({ id: z.string(), title: z.string(), url: z.string() })
	),
});
function readPersistedFixture(): PersistedFixture {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		return persistedFixtureSchema.parse(JSON.parse(stored));
	}
	const fresh: PersistedFixture = {
		annotations: { [INITIAL_TAB.id]: [] },
		tabs: [INITIAL_TAB],
	};
	localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
	return fresh;
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function browserContext(
	tab: FixtureTab,
	selections: z.infer<typeof rectSchema>[] = []
) {
	const rect = selections[0];
	const persisted = readPersistedFixture();
	return {
		annotations: persisted.annotations[tab.id] ?? [],
		page: { id: tab.id, title: tab.title, url: tab.url },
		screenshot: { encoding: "base64", image: FIXTURE_PNG, mime: "image/png" },
		...(rect
			? {
					selection: {
						rect: rect.width === 0 ? TARGET.rect : rect,
						targets: selections.map(() => TARGET),
					},
				}
			: undefined),
		snapshot: {
			elements: [
				{ depth: 0, name: tab.title, ref: "ax-1", role: "document" },
				{ depth: 1, name: "Open project", ref: "ax-2", role: "button" },
			],
			snapshot_id: `snapshot-${tab.id}`,
			tab: { id: tab.id, title: tab.title, url: tab.url },
			truncated: false,
		},
		viewport: { height: 900, scroll_x: 0, scroll_y: 0, width: 1440 },
	};
}

function installMocks(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		localStorage.removeItem(STORAGE_KEY);
		window.history.replaceState(null, "", window.location.pathname);
	}
	localStorage.removeItem(TOKEN_KEY);
	let delayContext = false;
	let failNext: { method: string; path: string } | null = null;
	let fixture = readPersistedFixture();
	const requests: CapturedRequest[] = [];
	const unexpectedRoutes: string[] = [];
	const state: BrowserProofState = {
		delayNextContext: () => {
			delayContext = true;
		},
		armNextFailure: (method, path) => {
			failNext = { method: method.toUpperCase(), path };
		},
		snapshot: () => {
			fixture = readPersistedFixture();
			return {
				annotations: structuredClone(fixture.annotations),
				assistant: {
					mode: useAssistantStore.getState().mode,
					pendingPrompt: useAssistantStore.getState().pendingPrompt,
				},
				requests: structuredClone(requests),
				tabs: structuredClone(fixture.tabs),
				unexpectedRoutes: [...unexpectedRoutes],
			};
		},
	};
	window.__browserAnnotationsCallerProof = state;

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const path = url.pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		const headers = new Headers(init?.headers);
		const request: CapturedRequest = {
			authorization: headers.get("authorization"),
			body,
			contentType: headers.get("content-type"),
			method,
			path,
			status: null,
		};
		requests.push(request);
		const reply = <Payload,>(responseBody: Payload, status = 200) => {
			request.status = status;
			return json(responseBody, status);
		};

		if (failNext?.method === method && failNext.path === path) {
			failNext = null;
			return reply({ error: "fixture_temporarily_unavailable" }, 503);
		}

		if (path === "/api/plugins" && method === "GET") {
			return reply({
				apps: [
					{
						built_in: false,
						enabled: true,
						id: "@ryu/browser",
						installed: true,
						installed_version: "1.0.0",
						local_only: true,
						name: "Browser",
						permission_grants: [],
						runnables: [],
						sidecar_name: "browser",
						version: "1.0.0",
					},
				],
			});
		}
		if (path === `${BROWSER_API}/theme` && method === "PUT") {
			return reply({ ok: true });
		}
		if (path === `${BROWSER_API}/tabs` && method === "GET") {
			fixture = readPersistedFixture();
			return reply({ tabs: fixture.tabs });
		}
		if (path === `${BROWSER_API}/tabs` && method === "POST") {
			const requestedUrl = z.object({ url: z.string() }).parse(body).url;
			const tab: FixtureTab = {
				id: "browser-proof-new-tab",
				title: "Workspace project preview",
				url: requestedUrl,
			};
			fixture = readPersistedFixture();
			if (!fixture.tabs.some((existing) => existing.id === tab.id)) {
				fixture.tabs.push(tab);
				fixture.annotations[tab.id] = [];
			}
			localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture));
			return reply({ tab }, 201);
		}

		const screenshotMatch = path.match(
			new RegExp(`^${BROWSER_API}/tabs/([^/]+)/screenshot$`)
		);
		if (screenshotMatch && method === "POST") {
			return reply({
				encoding: "base64",
				image: FIXTURE_PNG,
				mime: "image/png",
			});
		}

		const contextMatch = path.match(
			new RegExp(`^${BROWSER_API}/tabs/([^/]+)/context$`)
		);
		if (contextMatch && method === "POST") {
			fixture = readPersistedFixture();
			const tab = fixture.tabs.find(
				(candidate) =>
					candidate.id === decodeURIComponent(contextMatch[1] ?? "")
			);
			if (!tab) {
				return reply({ error: "tab_not_found" }, 404);
			}
			const selections =
				z.object({ selections: z.array(rectSchema).optional() }).parse(body)
					.selections ?? [];
			if (delayContext) {
				delayContext = false;
				await new Promise((resolve) => window.setTimeout(resolve, 350));
			}
			return reply(browserContext(tab, selections));
		}

		const annotationMatch = path.match(
			new RegExp(`^${BROWSER_API}/tabs/([^/]+)/annotations(?:/([^/]+))?$`)
		);
		if (annotationMatch && method === "POST" && !annotationMatch[2]) {
			fixture = readPersistedFixture();
			const tabId = decodeURIComponent(annotationMatch[1] ?? "");
			const input = annotationInputSchema.parse(body);
			const annotation: FixtureAnnotationTransportObservation = {
				comment: input.comment,
				created_at: "2026-10-01T00:00:00.000Z",
				id: `browser-proof-annotation-${(fixture.annotations[tabId] ?? []).length + 1}`,
				kind: input.kind,
				rect: input.rect,
				...(input.style ? { style: input.style } : undefined),
				targets: input.kind === "area" ? [] : [TARGET],
			};
			fixture.annotations[tabId] = [
				...(fixture.annotations[tabId] ?? []),
				annotation,
			];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture));
			return reply(annotation, 201);
		}
		if (annotationMatch && method === "DELETE") {
			fixture = readPersistedFixture();
			const tabId = decodeURIComponent(annotationMatch[1] ?? "");
			const annotationId = annotationMatch[2]
				? decodeURIComponent(annotationMatch[2])
				: null;
			const before = fixture.annotations[tabId] ?? [];
			fixture.annotations[tabId] = annotationId
				? before.filter((annotation) => annotation.id !== annotationId)
				: [];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture));
			return reply({
				ok: true,
				cleared: before.length > fixture.annotations[tabId].length,
			});
		}

		const tabMatch = path.match(new RegExp(`^${BROWSER_API}/tabs/([^/]+)$`));
		if (tabMatch && method === "DELETE") {
			fixture = readPersistedFixture();
			const tabId = decodeURIComponent(tabMatch[1] ?? "");
			fixture.tabs = fixture.tabs.filter((tab) => tab.id !== tabId);
			delete fixture.annotations[tabId];
			localStorage.setItem(STORAGE_KEY, JSON.stringify(fixture));
			return reply({ ok: true });
		}

		unexpectedRoutes.push(`${method} ${path}`);
		return reply({ error: "unexpected_fixture_route" }, 404);
	};
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
queryClient.setQueryData<AppInfo[]>(
	["desktop-app-roster", NODE.url, NODE.token, null],
	[BROWSER_APP]
);
installMocks();

function ProofSurface() {
	const [bottomOpen, setBottomOpen] = useState(false);
	const [rightOpen, setRightOpen] = useState(false);
	const [pinnedSummaryOpen, setPinnedSummaryOpen] = useState(true);

	return (
		<AppSurfaceProvider surface="desktop">
			<main className="mx-auto mt-6 flex h-[860px] w-[1280px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background text-foreground shadow-xl">
				<header className="flex shrink-0 items-center justify-between gap-4 border-border/60 border-b px-5 py-3">
					<div>
						<h1 className="font-semibold text-sm">Workspace browser panel</h1>
						<p className="text-muted-foreground text-xs">
							Production dock toggles and Browser panel backed by local Core
							fixtures.
						</p>
					</div>
					<div
						className="flex items-center gap-1"
						data-testid="workspace-panel-toggles"
					>
						<TooltipProvider delay={0}>
							<PanelToggleButtons
								bottomOpen={bottomOpen}
								onBottomToggle={() => setBottomOpen((open) => !open)}
								onPinnedSummaryToggle={() =>
									setPinnedSummaryOpen((open) => !open)
								}
								onRightToggle={() => setRightOpen((open) => !open)}
								pinnedSummaryOpen={pinnedSummaryOpen}
								rightOpen={rightOpen}
							/>
						</TooltipProvider>
					</div>
				</header>
				<div
					className="sr-only"
					data-bottom-open={String(bottomOpen)}
					data-pinned-summary-open={String(pinnedSummaryOpen)}
					data-right-open={String(rightOpen)}
					data-testid="workspace-panel-state"
				>
					Bottom: {bottomOpen ? "open" : "closed"} · Right:{" "}
					{rightOpen ? "open" : "closed"} · Pinned summary:{" "}
					{pinnedSummaryOpen ? "open" : "closed"}
				</div>
				<div className="min-h-0 flex-1">
					{bottomOpen ? (
						<BrowserTabPanel active title="Browser" />
					) : (
						<div className="flex h-full items-center justify-center text-muted-foreground text-xs">
							Open the bottom panel to use the Browser workspace tab.
						</div>
					)}
				</div>
				<Toaster position="bottom-right" theme="system" />
			</main>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<I18nProvider>
			<ProofSurface />
		</I18nProvider>
	);
}
