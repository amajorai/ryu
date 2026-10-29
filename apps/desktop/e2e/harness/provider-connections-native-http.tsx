import { Toaster } from "@ryu/ui/components/sileo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import "../../src/index.css";
const nativeUnexpected: Array<{
	command: string;
	args: unknown;
	error: string;
}> = [];
const dependencies = createChatPageNativeDependencies(localStorage);
let nextCallback = 0;
Object.defineProperty(window, "__providerProofNativeUnexpected", {
	value: nativeUnexpected,
});
Object.defineProperty(window, "__TAURI_INTERNALS__", {
	value: {
		metadata: {
			currentWindow: { label: "main" },
			currentWebview: { label: "main" },
		},
		invoke: async (command: string, args: Record<string, unknown> = {}) => {
			try {
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
		// Callback ids are handed out for the sealed-slot change subscription the
		// auth client makes; any other subscription still fails in invoke as an
		// unimplemented `plugin:event|listen`.
		transformCallback: () => {
			nextCallback += 1;
			return nextCallback;
		},
	},
});
const { LlmProvidersSettings } = await import(
	"../../src/components/settings/LlmProvidersSettings.tsx"
);
const { EntitlementProvider } = await import(
	"../../src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("../../src/store/useNodeStore.ts");
const node = {
	name: "owned-provider-retry",
	url: "http://127.0.0.1:5691",
	token: "provider-retry-owned-token",
	userJwt: null,
};
useNodeStore.setState({
	nodes: [node],
	localNodes: [node],
	cloudNodes: [],
	defaultNode: node.name,
	tabOverrides: {},
	autoSelect: false,
	autoSelectedNode: null,
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider
		client={
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, refetchOnWindowFocus: false },
				},
			})
		}
	>
		<EntitlementProvider>
			<main>
				<LlmProvidersSettings />
				<Toaster />
			</main>
		</EntitlementProvider>
	</QueryClientProvider>
);
