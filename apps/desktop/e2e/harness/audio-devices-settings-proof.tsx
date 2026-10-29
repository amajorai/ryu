import { createRoot } from "react-dom/client";
import { AudioDevicesSettings } from "../../src/components/settings/AudioDevicesSettings.tsx";
import "../../src/index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
	throw new Error("Audio device proof root was not found");
}

createRoot(rootElement).render(
	<main className="min-h-screen bg-background px-6 py-8 text-foreground">
		<div className="mx-auto max-w-3xl space-y-6">
			<header className="rounded-xl border bg-card p-6 shadow-sm">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
					Production AudioDevicesSettings · local media fixture
				</p>
				<h1 className="mt-2 font-semibold text-2xl">Audio settings</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					The browser APIs and external-open command are captured locally. No
					physical device or system settings panel is accessed.
				</p>
			</header>
			<section aria-label="Audio device settings">
				<AudioDevicesSettings />
			</section>
		</div>
	</main>
);
