import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BackupSettings } from "../../src/components/settings/BackupSettings.tsx";
import { StorageSettings } from "../../src/components/settings/StorageSettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import {
	emitProgress,
	installGatewayStorageFetch,
	invoke,
} from "./gateway-storage-settings-proof.mock.ts";
import "../../src/index.css";

declare global {
	interface Window {
		__emitGatewayStorageProgress?: typeof emitProgress;
		__TAURI_INTERNALS__?: {
			invoke: typeof invoke;
			transformCallback: (callback: (...args: unknown[]) => void) => number;
		};
	}
}

window.__TAURI_INTERNALS__ = {
	invoke,
	transformCallback: () => 1,
};

function ProofShell() {
	const spaceBackup = new URLSearchParams(window.location.search).has(
		"spaceBackup"
	);
	const queryClient = useMemo(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
		[]
	);

	if (!window.__emitGatewayStorageProgress) {
		window.__emitGatewayStorageProgress = emitProgress;
	}

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<div className="min-h-screen bg-background text-foreground">
					<main className="mx-auto max-w-5xl px-7 py-8">
						<header className="mb-7 flex items-start justify-between gap-6">
							<div>
								<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
									RYU · DESKTOP SETTINGS
								</p>
								<h1 className="font-medium text-3xl">
									{spaceBackup ? "Space backup settings" : "Storage"}
								</h1>
								<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
									Local data folder, backups, and the upload ceiling reported by
									the active node.
								</p>
							</div>
							<div className="rounded-full border border-success/50 bg-success/60 px-3 py-1.5 font-medium text-success text-xs">
								LOCAL API FIXTURES
							</div>
						</header>
						{spaceBackup ? (
							<BackupSettings
								spaceId="space-proof"
								target={{
									url: "http://127.0.0.1:18980",
									token: "storage-proof-token",
									userJwt: null,
								}}
							/>
						) : (
							<StorageSettings />
						)}
					</main>
					<Toaster position="bottom-right" theme="dark" />
				</div>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const restoreFetch = installGatewayStorageFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(<ProofShell />);
