import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import { DESKTOP_SECRET_CHANGED_EVENT } from "./desktop-secret-slots.ts";
import "../../src/index.css";
const nativeUnexpected: Array<{
	command: string;
	args: unknown;
	error: string;
}> = [];
const dependencies = createChatPageNativeDependencies(localStorage);
const callbacks = new Map<number, (payload: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
let nextCallback = 0;
let nextListener = 0;
Object.defineProperty(window, "__postureProofNativeUnexpected", {
	value: nativeUnexpected,
});
Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
	value: {
		unregisterListener: (event: string, id: number) => {
			const listener = listeners.get(id);
			if (listener?.event === event) {
				callbacks.delete(listener.handler);
			}
		},
	},
});
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	value: {
		metadata: {
			currentWindow: { label: "main" },
			currentWebview: { label: "main" },
		},
		invoke: async (command: string, args: Record<string, unknown> = {}) => {
			try {
				if (command === "plugin:event|listen") {
					if (
						typeof args.event !== "string" ||
						![
							"ryu:activate-entity",
							"tauri://resize",
							DESKTOP_SECRET_CHANGED_EVENT,
						].includes(args.event) ||
						typeof args.handler !== "number" ||
						!callbacks.has(args.handler) ||
						Object.keys(args).some(
							(key) => !["event", "target", "handler"].includes(key)
						)
					) {
						throw new Error("Unknown editor native event registration");
					}
					const id = ++nextListener;
					listeners.set(id, { event: args.event, handler: args.handler });
					return id;
				}
				if (command === "plugin:event|unlisten") {
					if (
						typeof args.eventId !== "number" ||
						typeof args.event !== "string" ||
						listeners.get(args.eventId)?.event !== args.event ||
						Object.keys(args).some((key) => !["event", "eventId"].includes(key))
					) {
						throw new Error("Unknown editor native listener cleanup");
					}
					listeners.delete(args.eventId);
					return null;
				}
				if (
					command === "plugin:store|load" &&
					args.path !== "auth.bin" &&
					args.path !== "entitlement.bin"
				) {
					throw new Error("Unowned native store path");
				}
				const result = dependencies.invoke(command, args);
				if (!result.handled) {
					throw new Error("Unimplemented native dependency");
				}
				return result.value;
			} catch (error) {
				nativeUnexpected.push({ command, args, error: String(error) });
				throw error;
			}
		},
		transformCallback: (callback: (payload: unknown) => void) => {
			const id = ++nextCallback;
			callbacks.set(id, callback);
			return id;
		},
		unregisterCallback: (id: number) => {
			callbacks.delete(id);
		},
	},
});
const { I18nProvider } = await import("@ryu/i18n/react");
const { MemoryRouter } = await import("react-router-dom");
const { AppSurfaceProvider } = await import(
	"../../src/contexts/app-surface-context.tsx"
);
const { EntitlementProvider } = await import(
	"../../src/contexts/entitlement-context.tsx"
);
const { TabsProvider } = await import("../../src/contexts/TabsContext.tsx");
const { TitleBarProvider } = await import(
	"../../src/contexts/TitleBarContext.tsx"
);
const { useProductModeStore } = await import("../../src/lib/product-mode.ts");
const { queryClient } = await import("../../src/lib/query-client.ts");
const { default: AgentEditPage } = await import(
	"../../src/pages/AgentEditPage.tsx"
);
const { useNodeStore } = await import("../../src/store/useNodeStore.ts");
const { apiUrl } = await import("../../src/lib/api/client.ts");
const nodes = ["a", "b"].map((scope) => ({
	name: `version-scope-${scope}`,
	url: `http://127.0.0.1:5731/scope-${scope}`,
	token: `version-bearer-${scope}`,
	userJwt: `version-user-${scope}`,
	managed: false,
	orgId: null,
}));
useNodeStore.setState({
	nodes,
	localNodes: nodes,
	defaultNode: nodes[0]!.name,
});
useProductModeStore.setState({ consoleAccess: true, requestedMode: "console" });
queryClient.clear();
queryClient.setDefaultOptions({
	queries: { retry: false, refetchOnWindowFocus: false },
});
function Fixture() {
	return (
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<MemoryRouter>
					<QueryClientProvider client={queryClient}>
						<EntitlementProvider>
							<TabsProvider
								initialTab={{
									path: "/library/agent/version-proof/edit",
									title: "Agent posture proof",
								}}
							>
								<TitleBarProvider>
									<nav aria-label="Fixture authority">
										<button
											onClick={() =>
												useNodeStore.setState({ defaultNode: nodes[0]!.name })
											}
											type="button"
										>
											Use scope A
										</button>
										<button
											onClick={() =>
												useNodeStore.setState({ defaultNode: nodes[1]!.name })
											}
											type="button"
										>
											Use scope B
										</button>
										<button
											onClick={() => {
												const original = nodes[0];
												if (!original) {
													throw new Error("Missing owned node A");
												}
												const alias = { ...original, url: `${original.url}/` };
												if (
													apiUrl(original, "/api/agents/version-proof") !==
													apiUrl(alias, "/api/agents/version-proof")
												) {
													throw new Error(
														"Fixture alias must match actual SDK endpoint"
													);
												}
												useNodeStore.setState({
													nodes: [alias, nodes[1]!],
													localNodes: [alias, nodes[1]!],
													defaultNode: alias.name,
												});
											}}
											type="button"
										>
											Use same node address alias
										</button>
									</nav>
									<AgentEditPage agentIdProp="version-proof" />
								</TitleBarProvider>
							</TabsProvider>
						</EntitlementProvider>
					</QueryClientProvider>
				</MemoryRouter>
			</I18nProvider>
		</AppSurfaceProvider>
	);
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing actual agent editor proof root");
}
createRoot(root).render(<Fixture />);
