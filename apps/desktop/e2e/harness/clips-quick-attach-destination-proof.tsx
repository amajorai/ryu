import { createRoot } from "react-dom/client";
import { ClipsQuickAttachSettings } from "../../src/components/settings/ClipsQuickAttachSettings.tsx";
import type { ClipsQuickAttachDestination } from "../../src/lib/clips-quick-attach.ts";
import "../../src/index.css";

interface TauriArgs {
	destination?: unknown;
	enabled?: unknown;
}

let destination: ClipsQuickAttachDestination = "automatic";
let enabled = true;

function status() {
	return {
		destination,
		enabled,
		error: null,
		input_monitoring: true,
		listening: true,
		supported: true,
	};
}

Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		invoke: async (command: string, args?: TauriArgs) => {
			document.body.dataset.lastCommand = command;
			if (command === "clips_quick_attach_set_destination") {
				if (
					args?.destination === "automatic" ||
					args?.destination === "current_chat" ||
					args?.destination === "new_chat"
				) {
					destination = args.destination;
					document.body.dataset.savedDestination = destination;
				}
				return status();
			}
			if (command === "clips_quick_attach_set_enabled") {
				enabled = args?.enabled === true;
				return status();
			}
			if (command === "clips_quick_attach_status") {
				return status();
			}
			throw new Error(`Unexpected command: ${command}`);
		},
		transformCallback: () => 0,
	},
});

function ProofArtifact() {
	return (
		<main className="min-h-screen bg-background px-8 py-8 text-foreground">
			<div className="mx-auto max-w-3xl">
				<header className="mb-6">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Desktop settings
					</p>
					<h1 className="mt-2 font-semibold text-2xl">Keyboard Shortcuts</h1>
				</header>
				<ClipsQuickAttachSettings />
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofArtifact />);
}
