import { RecordingPill } from "@ryu/blocks/island/recording-pill.tsx";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { VoiceModePanel } from "../../../../apps/island/src/renderer/components/VoiceModePanel.tsx";
import type { VoiceMode } from "../../../../apps/island/src/renderer/hooks/use-voice-mode.ts";
import "../../src/index.css";

const LEVELS = [0.18, 0.35, 0.55, 0.32, 0.82, 0.66, 0.94, 0.48];

const THINKING_VOICE: VoiceMode = {
	active: true,
	caption: "",
	error: null,
	interrupt: () => undefined,
	levels: LEVELS,
	phase: "thinking",
	start: () => undefined,
	stop: () => undefined,
	transcript: "",
};

function Proof() {
	return (
		<main className="min-h-screen bg-background px-10 py-12 text-foreground">
			<header className="mx-auto mb-8 max-w-4xl">
				<p className="mb-2 font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
					Ryu Island · Voice
				</p>
				<h1 className="font-semibold text-3xl tracking-tight">
					Speech, made visible
				</h1>
			</header>
			<div className="mx-auto grid max-w-4xl grid-cols-2 items-start gap-8">
				<section className="space-y-4" data-testid="push-to-talk-preview">
					<div>
						<p className="font-medium text-sm">Island voice input</p>
						<p className="text-muted-foreground text-xs">
							The lower-edge glow follows microphone level.
						</p>
					</div>
					<div className="rounded-2xl border border-border/70 bg-card/80 p-3 shadow-lg backdrop-blur-xl">
						<RecordingPill agentName="Ryu Assistant" canCycle levels={LEVELS} />
					</div>
				</section>
				<section className="space-y-4" data-testid="voice-mode-preview">
					<div>
						<p className="font-medium text-sm">Continuous voice mode</p>
						<p className="text-muted-foreground text-xs">
							The beam sweeps while the assistant is thinking.
						</p>
					</div>
					<div className="h-[360px] overflow-hidden rounded-4xl border border-border/70 bg-card/85 shadow-xl backdrop-blur-xl">
						<VoiceModePanel onClose={() => undefined} voice={THINKING_VOICE} />
					</div>
				</section>
			</div>
		</main>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Voice proof root is missing");
}

createRoot(rootElement).render(
	<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
		<Proof />
	</ThemeProvider>
);
