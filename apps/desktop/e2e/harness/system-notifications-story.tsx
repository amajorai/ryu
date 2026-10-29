// Real desktop notification consumer. No mocked fetch, event multiplexer,
// notification hook or toast implementation is used by this browser proof.
import { Toaster } from "@ryu/ui/components/sileo";
import { createRoot } from "react-dom/client";
import { createChatPageNativeDependencies } from "./chat-page-native-http-dependencies.ts";
import { isDesktopSecretCommand } from "./desktop-secret-slots.ts";
import "../../src/index.css";
// Reuse the finite SDK-faithful owned-store adapter before auth modules load.
// Only auth.bin and the sealed auth-vault / license-key slots (with their
// change subscription) are available here; unrelated native calls remain
// strict errors.
const dependencies = createChatPageNativeDependencies(localStorage);
const nativeBridge = Reflect.get(window, "__TAURI_INTERNALS__");
if (!nativeBridge || typeof nativeBridge.invoke !== "function") {
	throw new Error("Missing notification proof native boundary");
}
const originalInvoke: (
	command: string,
	args?: Record<string, unknown>
) => Promise<unknown> = nativeBridge.invoke.bind(nativeBridge);
Object.defineProperty(nativeBridge, "invoke", {
	value: async (command: string, args?: Record<string, unknown>) => {
		if (
			command.startsWith("plugin:store|") ||
			isDesktopSecretCommand(command, args)
		) {
			try {
				if (command === "plugin:store|load" && args?.path !== "auth.bin") {
					throw new Error("Notification proof only owns auth.bin");
				}
				const result = dependencies.invoke(command, args);
				if (result.handled) {
					return result.value;
				}
			} catch (error) {
				const unexpected = Reflect.get(
					window,
					"__notificationUnexpectedNative"
				);
				if (Array.isArray(unexpected)) {
					unexpected.push(command);
				}
				throw error;
			}
		}
		return originalInvoke(command, args);
	},
});
// The SDK takes a callback id before it invokes `plugin:event|listen`, so ids
// are handed out here; a listen for any event but the sealed-slot change still
// reaches the strict boundary above and is recorded there.
let nextCallback = 0;
Object.defineProperty(nativeBridge, "transformCallback", {
	value: () => {
		nextCallback += 1;
		return nextCallback;
	},
});
const { useDesktopNotificationsStream } = await import(
	"../../src/hooks/useDesktopNotificationsStream.ts"
);
const { useNodeStore } = await import("../../src/store/useNodeStore.ts");
const NODE = {
	name: "Notification proof",
	url: "http://127.0.0.1:5661",
	token: "notification-node-a",
	userJwt: "notification-user-a",
};
useNodeStore.setState({
	nodes: [NODE],
	localNodes: [NODE],
	defaultNode: NODE.name,
	autoSelect: false,
	tabOverrides: {},
});
Object.defineProperty(window, "__notificationNodeStore", {
	value: useNodeStore,
});
function SystemNotificationsStory() {
	useDesktopNotificationsStream();
	return (
		<>
			<main className="min-h-screen bg-background p-8 text-foreground">
				<h1>System notifications</h1>
				<p>
					Notifications below are delivered by the active node's actual
					authenticated event stream.
				</p>
			</main>
			<Toaster />
		</>
	);
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing notification proof root");
}
createRoot(root).render(<SystemNotificationsStory />);
