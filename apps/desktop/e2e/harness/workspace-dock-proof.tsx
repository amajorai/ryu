import { I18nProvider } from "@ryu/i18n/react";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { mockIPC } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import browserManifest from "../../../../apps-store/browser/manifest.json" with {
	type: "json",
};
import simulatorManifest from "../../../../apps-store/simulator/manifest.json" with {
	type: "json",
};
import { ProjectDockHost } from "../../src/components/panels/ProjectDockHost.tsx";
import {
	PanelToggleButtons,
	WorkspacePanels,
} from "../../src/components/panels/WorkspacePanels.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	CurrentTabIdProvider,
	TabsProvider,
	useTabsContext,
} from "../../src/contexts/TabsContext.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import { ENTITY_ACTIVATION_EVENT } from "../../src/lib/window-routing.ts";
import { useDockPanelRequestStore } from "../../src/store/useDockPanelRequestStore.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useProjectDockStore } from "../../src/store/useProjectDockStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import "../../src/index.css";

localStorage.setItem("ryu_startup_behavior", "restore");
if (!localStorage.getItem("ryu_session_tabs")) {
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			tabs: [{ path: "/chat", title: "Project conversation" }],
			activeIndex: 0,
		})
	);
}

const node = {
	name: "dock-fixture",
	url: "http://127.0.0.1:5412",
	token: "dock-fixture-token",
	userJwt: null,
};
const httpRequests: {
	path: string;
	method: string;
	body: unknown;
	authorization: string | null;
	status: number;
}[] = [];
const deviceKey = "workspace-dock-proof-device";
let deviceState = localStorage.getItem(deviceKey) ?? "shutdown";
let failAction = false;
const canvas = document.createElement("canvas");
canvas.width = 240;
canvas.height = 400;
const ctx = canvas.getContext("2d")!;
ctx.fillStyle = "#182434";
ctx.fillRect(0, 0, 240, 400);
ctx.fillStyle = "#ffffff";
ctx.font = "18px sans-serif";
ctx.fillText("Fixture device", 38, 190);
const screenshot = canvas.toDataURL("image/png").split(",")[1];
const requests: { command: string; args: unknown }[] = [];
let failShell = false;
const nativeFailureKey = "workspace-dock-proof-unexpected-native";
const routeFailureKey = "workspace-dock-proof-unexpected-routes";
function readFailures(key: string): string[] {
	const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new TypeError("Invalid persisted WorkspaceDock failure ledger");
	}
	return value;
}
const unexpectedNativeCommands = readFailures(nativeFailureKey);
function refuseNative(command: string, args: unknown, reason: string): never {
	unexpectedNativeCommands.push(
		`${command}: ${reason}: ${JSON.stringify(args)}`
	);
	sessionStorage.setItem(
		nativeFailureKey,
		JSON.stringify(unexpectedNativeCommands)
	);
	throw new Error(
		`WorkspaceDock native contract refused ${command}: ${reason}`
	);
}
/** Only plain JSON-object IPC arguments are part of these finite contracts;
    arrays and binary payloads are refused rather than read as records. */
function isNativeRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function nativePayload(
	command: string,
	args: unknown
): Record<string, unknown> {
	if (args === undefined) {
		return {};
	}
	if (!isNativeRecord(args)) {
		return refuseNative(command, args, "arguments must be an object");
	}
	return args;
}
function requireNativeFields(
	command: string,
	args: Record<string, unknown>,
	required: string[],
	optional: string[] = []
) {
	if (
		required.some((key) => !Object.hasOwn(args, key)) ||
		Object.keys(args).some(
			(key) => !(required.includes(key) || optional.includes(key))
		)
	) {
		refuseNative(command, args, "unexpected argument fields");
	}
}
const nativeDependencies = createChatPageNativeDependencies({
	getItem: (key) =>
		localStorage.getItem(
			key.replace(
				"chat-page-native-store:",
				"workspace-dock-proof-native-store:"
			)
		),
	setItem: (key, value) =>
		localStorage.setItem(
			key.replace(
				"chat-page-native-store:",
				"workspace-dock-proof-native-store:"
			),
			value
		),
});
const nativeListeners = new Map<number, { event: string; handler: number }>();
let nextNativeListener = 0;
mockIPC((command, args) => {
	requests.push({ command, args });
	const payload = nativePayload(command, args);
	if (command === "get_editor_availability") {
		requireNativeFields(command, payload, ["editors"]);
		const editors = [
			"vscode",
			"cursor",
			"zed",
			"gitbash",
			"terminal",
			...(navigator.userAgent.includes("Windows") ? ["powershell", "cmd"] : []),
			"explorer",
		];
		if (
			!Array.isArray(payload.editors) ||
			payload.editors.length !== editors.length ||
			payload.editors.some((id, index) => id !== editors[index])
		) {
			refuseNative(command, args, "unexpected platform editor probe");
		}
		return editors.map((id) => ({
			id,
			available: ["explorer", "vscode", "terminal"].includes(id),
		}));
	}
	if (command === "shell_execute") {
		requireNativeFields(command, payload, ["command", "cwd", "shell"], ["env"]);
		const normalCommand =
			typeof payload.command === "string" &&
			["fixture status", "fixture retry", "fixture readback"].includes(
				payload.command
			) &&
			payload.cwd === "/fixture/project" &&
			payload.shell === null &&
			payload.env === undefined;
		const requestedCommand =
			payload.command === "fixture setup" &&
			payload.cwd === "/fixture/setup" &&
			payload.shell === "zsh" &&
			payload.env !== null &&
			typeof payload.env === "object" &&
			!Array.isArray(payload.env) &&
			Object.keys(payload.env).length === 1 &&
			Object.hasOwn(payload.env, "FIXTURE") &&
			Reflect.get(payload.env, "FIXTURE") === "yes";
		if (!(normalCommand || requestedCommand)) {
			refuseNative(command, args, "undeclared shell request");
		}
		if (failShell) {
			failShell = false;
			throw new Error("Fixture shell unavailable");
		}
		return {
			stdout: "Fixture command completed",
			stderr: "Fixture stderr",
			code: 0,
		};
	}
	if (command === "open_in_editor") {
		requireNativeFields(command, payload, ["editor", "path"]);
		if (payload.editor !== "vscode" || payload.path !== "/fixture/project") {
			refuseNative(command, args, "undeclared editor request");
		}
		return null;
	}
	if (command === "plugin:event|listen") {
		requireNativeFields(command, payload, ["event", "target", "handler"]);
		if (
			// Shipping subscriptions: node roster changes and the TabsContext
			// window-routing entity activation (`ENTITY_ACTIVATION_EVENT`).
			(payload.event !== "nodes-changed" &&
				payload.event !== ENTITY_ACTIVATION_EVENT) ||
			payload.target === null ||
			typeof payload.target !== "object" ||
			Array.isArray(payload.target) ||
			Object.keys(payload.target).length !== 1 ||
			!Object.hasOwn(payload.target, "kind") ||
			Reflect.get(payload.target, "kind") !== "Any" ||
			typeof payload.handler !== "number" ||
			!Number.isSafeInteger(payload.handler) ||
			payload.handler < 0
		) {
			refuseNative(command, args, "undeclared event subscription");
		}
		const id = ++nextNativeListener;
		nativeListeners.set(id, { event: payload.event, handler: payload.handler });
		return id;
	}
	if (command === "plugin:event|unlisten") {
		requireNativeFields(command, payload, ["event", "eventId"]);
		if (
			typeof payload.eventId !== "number" ||
			nativeListeners.get(payload.eventId)?.event !== payload.event
		) {
			refuseNative(command, args, "unknown owned event subscription");
		}
		nativeListeners.delete(payload.eventId);
		return null;
	}
	try {
		const dependency = nativeDependencies.invoke(command, payload);
		if (dependency.handled) {
			return dependency.value;
		}
	} catch (error) {
		refuseNative(
			command,
			args,
			error instanceof Error ? error.message : String(error)
		);
	}
	return refuseNative(command, args, "unknown native command");
});
useNodeStore.setState({
	nodes: [node],
	localNodes: [node],
	cloudNodes: [],
	defaultNode: node.name,
});
useWorkspaceStore.setState({ folder: "/fixture/project" });
const iframeProof = new URLSearchParams(location.search).has("iframe");
if (!iframeProof) {
	queryClient.setQueryData(
		["desktop-app-roster", node.url, node.token, null],
		[{ id: simulatorManifest.id, enabled: true }]
	);
}
const unexpectedRoutes = readFailures(routeFailureKey);
function refuseRoute(method: string, url: URL, reason: string) {
	unexpectedRoutes.push(`${method} ${url.href}: ${reason}`);
	sessionStorage.setItem(routeFailureKey, JSON.stringify(unexpectedRoutes));
	return Response.json({ error: reason }, { status: 404 });
}
const simulatorBase = "/api/ext/@ryu/simulator";
const simulatorDevice = `${simulatorBase}/devices/android%20fixture%2F1`;
const preferencePaths = new Set([
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
]);
const preferences = new Map<string, string>();
window.fetch = async (input, init) => {
	const request = new Request(
		input instanceof Request ? input : new URL(String(input), location.href),
		init
	);
	const url = new URL(request.url);
	const method = request.method;
	const rawBody = request.body ? await request.clone().text() : "";
	if (
		url.origin !== node.url ||
		url.search ||
		request.headers.get("authorization") !== `Bearer ${node.token}` ||
		request.headers.get("x-ryu-user-jwt") !== null
	) {
		return refuseRoute(method, url, "unexpected origin, query or authority");
	}
	if (url.pathname === "/api/plugins/contributions") {
		if (method !== "GET" || rawBody) {
			return refuseRoute(method, url, "invalid contributions read");
		}
		const manifest = iframeProof ? browserManifest : simulatorManifest;
		return Response.json({
			dock_panels: manifest.contributes.dock_panels.map((panel) => ({
				...panel,
				plugin: manifest.id,
			})),
		});
	}
	if (iframeProof && url.pathname === "/api/plugins") {
		if (method !== "GET" || rawBody) {
			return refuseRoute(method, url, "invalid roster read");
		}
		return new Promise<Response>((_resolve, reject) => {
			request.signal.addEventListener(
				"abort",
				() => reject(new DOMException("Roster request canceled", "AbortError")),
				{ once: true }
			);
		});
	}
	if (url.pathname.startsWith(`${simulatorBase}/`)) {
		const reads = [
			`${simulatorBase}/capabilities`,
			`${simulatorBase}/devices`,
			`${simulatorDevice}/screenshot`,
		];
		let body: unknown = null;
		if (rawBody) {
			try {
				body = JSON.parse(rawBody);
			} catch {
				return refuseRoute(method, url, "invalid Simulator JSON body");
			}
		}
		const fields =
			body !== null && typeof body === "object" && !Array.isArray(body)
				? Object.keys(body)
				: [];
		const read =
			method === "GET" && reads.includes(url.pathname) && body === null;
		const lifecycle =
			method === "POST" &&
			body === null &&
			[`${simulatorDevice}/boot`, `${simulatorDevice}/shutdown`].includes(
				url.pathname
			);
		const tap =
			method === "POST" &&
			url.pathname === `${simulatorDevice}/tap` &&
			fields.length === 2 &&
			fields.includes("x") &&
			fields.includes("y") &&
			body !== null &&
			typeof body === "object" &&
			Number.isSafeInteger(Reflect.get(body, "x")) &&
			Number.isSafeInteger(Reflect.get(body, "y")) &&
			Reflect.get(body, "x") >= 0 &&
			Reflect.get(body, "x") < 240 &&
			Reflect.get(body, "y") >= 0 &&
			Reflect.get(body, "y") < 400;
		const key =
			method === "POST" &&
			url.pathname === `${simulatorDevice}/key` &&
			fields.length === 1 &&
			fields[0] === "key" &&
			body !== null &&
			typeof body === "object" &&
			["home", "back"].includes(Reflect.get(body, "key"));
		if (!(read || lifecycle || tap || key)) {
			return refuseRoute(method, url, "undeclared Simulator request");
		}
		const status = failAction && method === "POST" ? 503 : 200;
		httpRequests.push({
			path: url.pathname,
			method,
			body,
			authorization: request.headers.get("authorization"),
			status,
		});
		if (status === 503) {
			failAction = false;
			return Response.json({ error: "fixture unavailable" }, { status });
		}
		if (url.pathname.endsWith("/capabilities")) {
			return Response.json({
				ios: {
					available: false,
					interactive: false,
					reason: "Fixture node has no iOS runtime",
				},
				android: { available: true, interactive: true },
			});
		}
		if (url.pathname.endsWith("/devices")) {
			return Response.json({
				devices: [
					{
						id: "android fixture/1",
						name: "Android fixture",
						os: "Android 15",
						platform: "android",
						state: deviceState,
					},
				],
			});
		}
		if (url.pathname.endsWith("/screenshot")) {
			return Response.json({ image: screenshot });
		}
		if (url.pathname.endsWith("/boot")) {
			deviceState = "booted";
		}
		if (url.pathname.endsWith("/shutdown")) {
			deviceState = "shutdown";
		}
		localStorage.setItem(deviceKey, deviceState);
		return Response.json({ ok: true });
	}
	if (preferencePaths.has(url.pathname)) {
		if (method === "GET" && !rawBody) {
			return Response.json({ value: preferences.get(url.pathname) ?? "false" });
		}
		let body: unknown;
		try {
			body = JSON.parse(rawBody);
		} catch {
			return refuseRoute(method, url, "invalid preference JSON body");
		}
		if (
			method === "PUT" &&
			body !== null &&
			typeof body === "object" &&
			!Array.isArray(body) &&
			Object.keys(body).length === 1 &&
			Object.hasOwn(body, "value") &&
			["true", "false"].includes(Reflect.get(body, "value"))
		) {
			preferences.set(url.pathname, Reflect.get(body, "value"));
			return Response.json({ ok: true });
		}
		return refuseRoute(method, url, "undeclared preference request");
	}
	return refuseRoute(method, url, "unhandled fixture request");
};

export interface WorkspaceDockProofKernel {
	failAction: () => void;
	failShell: () => void;
	openCommand: () => ReturnType<
		ReturnType<typeof useDockPanelRequestStore.getState>["open"]
	>;
	snapshot: () => {
		httpRequests: typeof httpRequests;
		deviceState: typeof deviceState;
		requests: typeof requests;
		unexpectedRoutes: typeof unexpectedRoutes;
		unexpectedNativeCommands: typeof unexpectedNativeCommands;
		tabs: ReturnType<typeof useTabsContext>["tabs"];
		projects: ReturnType<typeof useProjectDockStore.getState>["byFolder"];
		storage: ReturnType<Storage["getItem"]>;
	};
}

declare const window: Window & { dockProof: WorkspaceDockProofKernel };

function Surface() {
	const tabs = useTabsContext();
	const current = tabs.tabs[0];
	const [bottomOpen, setBottomOpen] = useState(false);
	const [rightOpen, setRightOpen] = useState(false);
	window.dockProof = {
		snapshot: () => ({
			httpRequests,
			deviceState,
			requests,
			unexpectedRoutes,
			unexpectedNativeCommands,
			tabs: tabs.tabs,
			projects: useProjectDockStore.getState().byFolder,
			storage: localStorage.getItem("ryu_session_tabs"),
		}),
		failAction: () => {
			failAction = true;
		},
		failShell: () => {
			failShell = true;
		},
		openCommand: () =>
			useDockPanelRequestStore
				.getState()
				.open("terminal", "Environment", "bottom", {
					command: "fixture setup",
					cwd: "/fixture/setup",
					shell: "zsh",
					env: { FIXTURE: "yes" },
				}),
	} satisfies WorkspaceDockProofKernel;
	if (!current) {
		return <p>No window tab</p>;
	}
	return (
		<CurrentTabIdProvider tabId={current.id}>
			<ProjectDockHost>
				<div className="flex h-screen flex-col bg-background text-foreground">
					<header className="flex h-12 items-center justify-between border-b px-4">
						<span className="font-medium">Project workspace</span>
						<PanelToggleButtons
							bottomOpen={bottomOpen}
							folder="/fixture/project"
							onBottomToggle={() => setBottomOpen((v) => !v)}
							onRightToggle={() => setRightOpen((v) => !v)}
							rightOpen={rightOpen}
						/>
					</header>
					<div className="min-h-0 flex-1">
						<WorkspacePanels
							bottomOpen={bottomOpen}
							folder="/fixture/project"
							onBottomOpenChange={setBottomOpen}
							onRightOpenChange={setRightOpen}
							rightOpen={rightOpen}
						>
							<main className="p-8">
								<h1 className="font-medium text-xl">Workspace dock</h1>
								<p className="mt-2 text-muted-foreground">
									Project tools stay available beside the conversation.
								</p>
							</main>
						</WorkspacePanels>
					</div>
				</div>
			</ProjectDockHost>
		</CurrentTabIdProvider>
	);
}

createRoot(document.getElementById("root")!).render(
	<I18nProvider>
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<AppSurfaceProvider surface="desktop">
					<TooltipProvider>
						<EntitlementProvider>
							<TabsProvider>
								<Surface />
							</TabsProvider>
						</EntitlementProvider>
					</TooltipProvider>
				</AppSurfaceProvider>
			</MemoryRouter>
		</QueryClientProvider>
	</I18nProvider>
);
