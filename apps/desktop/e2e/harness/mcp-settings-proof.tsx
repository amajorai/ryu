import { Button } from "@ryu/ui/components/button.tsx";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { McpSettingsPanel } from "../../src/components/settings/McpSettingsPanel.tsx";
import "../../src/index.css";

function SettingsProof() {
	const [dark, setDark] = useState(false);
	return (
		<main
			className={`${dark ? "dark" : ""} min-h-screen bg-background p-6 text-foreground`}
		>
			<div className="mx-auto flex max-w-2xl flex-col gap-6">
				<div className="flex items-start justify-between gap-4">
					<div>
						<h1 className="font-medium text-xl">Plugin settings</h1>
						<p className="mt-2 text-muted-foreground text-sm">
							Local integration fixture · production settings renderer with a
							persistent test backend
						</p>
					</div>
					<Button onClick={() => setDark(!dark)} variant="outline">
						{dark ? "Light mode" : "Dark mode"}
					</Button>
				</div>
				<section
					aria-label="Parts plugin settings"
					className="rounded-lg border bg-card p-6 text-card-foreground"
				>
					<McpSettingsPanel
						plugin="@fixture/parts"
						settings={{
							serverId: "parts",
							readTool: "parts.settings.read",
							updateTool: "parts.settings.update",
						}}
						target={{ url: location.origin, token: "settings-proof" }}
					/>
				</section>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<SettingsProof />);
