import { createRoot } from "react-dom/client";
import { SplitPresetSettings } from "../../src/components/settings/SplitPresetSettings.tsx";
import "../../src/index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
	throw new Error("Split preset proof root was not found");
}

createRoot(rootElement).render(
	<main className="min-h-screen bg-background px-6 py-8 text-foreground">
		<div className="mx-auto max-w-3xl space-y-6">
			<header className="rounded-xl border bg-card p-6 shadow-sm">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
					Production SplitPresetSettings · isolated local preset store
				</p>
				<h1 className="mt-2 font-semibold text-2xl">General settings</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					This proof uses the actual pane-preset component and localStorage
					store. It does not open panes or access project files.
				</p>
			</header>
			<section
				aria-label="Pane layout preset controls"
				data-proof-component="SplitPresetSettings"
			>
				<SplitPresetSettings />
			</section>
		</div>
	</main>
);

document.body.dataset.harnessReady = "1";
