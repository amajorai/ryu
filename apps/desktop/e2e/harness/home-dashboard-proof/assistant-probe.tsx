import { useAssistantStore } from "@/src/store/useAssistantStore.ts";

/**
 * Stands in for the global Ask Ryu panel: shows what Home handed the ONE
 * assistant (its builder surface and any queued starter prompt) so the proof
 * can assert there is no second chat pane, only the shared assistant.
 */
export function AssistantProbe() {
	const builder = useAssistantStore((s) => s.builder);
	const mode = useAssistantStore((s) => s.mode);
	const pendingPrompt = useAssistantStore((s) => s.pendingPrompt);
	const close = useAssistantStore((s) => s.close);
	if (mode === "closed") {
		return null;
	}
	return (
		<section aria-label="Ask Ryu" data-testid="home-builder-panel">
			<p data-testid="home-assistant-mode">{mode}</p>
			{builder && (
				<>
					<h2>{builder.label}</h2>
					<p data-testid="home-builder-kind">{builder.kind}</p>
					<p data-testid="home-builder-target">{builder.targetId}</p>
					<p data-testid="home-builder-thread">{builder.thread}</p>
				</>
			)}
			{pendingPrompt && (
				<p data-testid="home-builder-auto-prompt">{pendingPrompt}</p>
			)}
			<button onClick={close} type="button">
				Close assistant
			</button>
		</section>
	);
}
