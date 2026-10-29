import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SettingsSyncTab } from "@/src/components/settings/SettingsSyncTab.tsx";
import { startSettingsSync } from "@/src/lib/settings-sync/engine.ts";
import "../../src/index.css";

function SettingsSyncProof() {
	useEffect(() => startSettingsSync(), []);

	return (
		<main className="dark min-h-screen bg-background px-8 py-6 text-foreground">
			<div className="mx-auto max-w-4xl">
				<SettingsSyncTab />
			</div>
			<Toaster position="bottom-right" theme="dark" />
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<SettingsSyncProof />);
