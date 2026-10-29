import { Toaster } from "@ryu/ui/components/sileo";
import { QueryClientProvider } from "@tanstack/react-query";
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
Object.defineProperty(window, "__spacesUploadNativeUnexpected", {
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
const { SpacesProvider, useSpacesContext } = await import(
	"../../src/contexts/SpacesContext.tsx"
);
const { SpaceFileDropzone } = await import(
	"../../src/components/spaces/SpaceFileDropzone.tsx"
);
const { EntitlementProvider } = await import(
	"../../src/contexts/entitlement-context.tsx"
);
const { useNodeStore } = await import("../../src/store/useNodeStore.ts");
const { queryClient } = await import("../../src/lib/query-client.ts");
const { useEffect, useState } = await import("react");
const node = {
	name: "owned-upload",
	url: "http://127.0.0.1:5711",
	token: "spaces-upload-owned-token",
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
function UploadSurface() {
	const spaces = useSpacesContext();
	const [documents, setDocuments] = useState<
		Array<{ id: string; title: string }>
	>([]);
	const [readError, setReadError] = useState<string | null>(null);
	const revision = spaces.documentRevisions.get("space-owned") ?? 0;
	useEffect(() => {
		let live = true;
		spaces.listDocuments("space-owned").then(
			(rows) => {
				if (live) {
					setDocuments(rows);
				}
			},
			(error) => {
				if (live) {
					setReadError(String(error));
				}
			}
		);
		return () => {
			live = false;
		};
	}, [revision, spaces.listDocuments]);
	return (
		<main>
			<h1>Space uploads</h1>
			<p data-testid="space-count">
				{spaces.loading
					? "Loading spaces..."
					: `${spaces.spaces.find((space) => space.id === "space-owned")?.documentCount ?? 0} documents`}
			</p>
			<SpaceFileDropzone spaceId="space-owned" />
			<ul aria-label="Persisted documents">
				{documents.map((document) => (
					<li key={document.id}>{document.title}</li>
				))}
			</ul>
			{readError && <p role="alert">{readError}</p>}
			<Toaster />
		</main>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<EntitlementProvider>
			<SpacesProvider>
				<UploadSurface />
			</SpacesProvider>
		</EntitlementProvider>
	</QueryClientProvider>
);
