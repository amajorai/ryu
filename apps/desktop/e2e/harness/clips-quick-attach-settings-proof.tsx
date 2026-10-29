import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { ClipsQuickAttachSettings } from "../../src/components/settings/ClipsQuickAttachSettings.tsx";
import "../../src/index.css";

type Destination = "automatic" | "current_chat" | "new_chat";

interface ClipsQuickAttachStatus {
	destination: Destination;
	enabled: boolean;
	error: string | null;
	input_monitoring: boolean;
	listening: boolean;
	supported: boolean;
}

interface NativeCall {
	args?: { enabled?: boolean; url?: string };
	command: string;
}

interface ProofWindow extends Window {
	__clipsQuickAttachCalls: NativeCall[];
	__clipsQuickAttachStatus: ClipsQuickAttachStatus;
	__rejectFirstDestination: boolean;
	__rejectFirstEnable: boolean;
}

// SAFETY: This write view initializes the call array, complete local status, and rejection flag below before rendering. Call args remain opaque; status changes use the existing boolean comparisons.
const proofWindow = window as ProofWindow;
const params = new URLSearchParams(window.location.search);
proofWindow.__clipsQuickAttachCalls = [];
proofWindow.__clipsQuickAttachStatus = {
	destination:
		(localStorage.getItem("clips-destination-proof") as Destination) ??
		"automatic",
	enabled: false,
	error: null,
	input_monitoring: params.get("permission") === "granted",
	listening: false,
	supported: params.get("scenario") !== "unsupported",
};
proofWindow.__rejectFirstEnable = params.get("scenario") === "retry";
proofWindow.__rejectFirstDestination =
	params.get("scenario") === "destination-retry";

const proofTauriKernel = {
	invoke: async (
		command: string,
		args?: { enabled?: boolean; url?: string }
	) => {
		proofWindow.__clipsQuickAttachCalls.push({ command, args });
		const status = proofWindow.__clipsQuickAttachStatus;

		if (command === "clips_quick_attach_status") {
			return { ...status };
		}
		if (command === "clips_quick_attach_set_enabled") {
			const enabled = args?.enabled === true;
			if (enabled && proofWindow.__rejectFirstEnable) {
				proofWindow.__rejectFirstEnable = false;
				throw new Error("Native listener could not start");
			}
			const permissionGranted =
				!navigator.userAgent.includes("Mac") || status.input_monitoring;
			if (enabled && !permissionGranted) {
				throw new Error("Grant Input Monitoring to Ryu, then try again.");
			}
			status.enabled = enabled;
			status.listening = enabled;
			status.error = null;
			return { ...status };
		}
		if (command === "request_input_monitoring_permission") {
			status.input_monitoring = true;
			return true;
		}
		if (command === "clips_quick_attach_set_destination") {
			if (proofWindow.__rejectFirstDestination) {
				proofWindow.__rejectFirstDestination = false;
				throw new Error("Destination could not be saved");
			}
			const destination = args?.destination;
			if (
				destination !== "automatic" &&
				destination !== "current_chat" &&
				destination !== "new_chat"
			) {
				throw new Error("Unexpected Clips destination");
			}
			status.destination = destination;
			localStorage.setItem("clips-destination-proof", destination);
			return { ...status };
		}
		if (
			command === "open_privacy_settings" &&
			args?.capability === "inputMonitoring"
		) {
			return null;
		}

		throw new Error(`Unexpected native command: ${command}`);
	},
	transformCallback: () => 0,
};
// SAFETY: The mutation view installs this exact complete authored private kernel.
// Its inferred results come from the unchanged fixture bodies, not the public Tauri generic ABI.
(
	proofWindow as Omit<typeof proofWindow, "__TAURI_INTERNALS__"> & {
		__TAURI_INTERNALS__: typeof proofTauriKernel;
	}
).__TAURI_INTERNALS__ = proofTauriKernel;

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<I18nProvider>
			<I18nDirectionProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<Toaster position="bottom-right" theme="dark" />
					<main className="min-h-dvh bg-background p-8 text-foreground">
						<div className="mx-auto max-w-3xl rounded-2xl border bg-card p-6 shadow-sm">
							<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
								Desktop settings verification
							</p>
							<h1 className="mt-2 font-semibold text-2xl">
								Clips quick attach
							</h1>
							<div className="mt-6">
								<ClipsQuickAttachSettings />
							</div>
						</div>
					</main>
				</ThemeProvider>
			</I18nDirectionProvider>
		</I18nProvider>
	);
}
