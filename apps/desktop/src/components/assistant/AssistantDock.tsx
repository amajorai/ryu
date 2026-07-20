import { Logo } from "@ryu/ui/components/logo";
import { useEffect, useState } from "react";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { AssistantPanel } from "./AssistantPanel.tsx";
import { MorphPopover } from "./MorphPopover.tsx";
import { ISLAND_CHROME, ISLAND_FILL } from "./skin.ts";

// The resting circle matches the island's LOGO_CIRCLE (40px, 34px eyes) exactly,
// so the two Ryu surfaces read as the same creature. The floating window's frame
// mirrors AssistantPanel's floating dimensions (400 × min(620, viewport − 2rem))
// so the morph lands on the real panel size.
const TRIGGER_SIZE = 40;
const EYES_SIZE = "34px";
const PANEL_WIDTH = 400;
const PANEL_MAX_HEIGHT = 620;
const PANEL_VIEWPORT_MARGIN = 32;

/**
 * The always-present Ask Ryu surface. When closed it's a round button wearing the
 * island's cursor-tracking, blinking eyes (`Logo variant="eyes"`, zoomed in). Tap
 * it and the button springs straight into the floating chat window — one glass
 * surface morphing open, no menu, the window *is* the morph target (it hosts
 * `<AssistantPanel bare />` as the popover's content). The panel's own close
 * control (or Escape) melts it back.
 *
 * The docked **sidebar** layout is a full-height frame of its own, so Layout
 * renders that as a plain `<AssistantPanel />`; this dock owns only the closed and
 * floating states.
 */
export function AssistantDock() {
	const mode = useAssistantStore((s) => s.mode);
	const open = useAssistantStore((s) => s.open);
	const close = useAssistantStore((s) => s.close);

	// Clamp the morph target to the viewport, matching the panel's
	// `h-[min(620px,calc(100vh-2rem))]`.
	const [panelHeight, setPanelHeight] = useState(PANEL_MAX_HEIGHT);
	useEffect(() => {
		const measure = () =>
			setPanelHeight(
				Math.min(PANEL_MAX_HEIGHT, window.innerHeight - PANEL_VIEWPORT_MARGIN)
			);
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);

	if (mode === "sidebar") {
		return null;
	}

	return (
		<MorphPopover
			// One glass surface throughout: the fill + chrome stay on through the
			// whole morph (no mid-morph flip to transparent), so the launcher and the
			// open panel read as the same card relaxing open.
			bgClassName={ISLAND_FILL}
			chromeClassName={ISLAND_CHROME}
			className="fixed right-4 bottom-4 z-50"
			contentHeight={panelHeight}
			contentWidth={PANEL_WIDTH}
			dismissable={false}
			isOpen={mode === "floating"}
			onOpenChange={(next) => (next ? open("floating") : close())}
			trigger={
				// The island's exact eyes: 34px in a 40px circle, drawn in the skin's
				// light text color (currentColor) on the dark glass.
				<Logo className="text-current" size={EYES_SIZE} variant="eyes" />
			}
			triggerLabel="Ask Ryu"
			triggerSize={TRIGGER_SIZE}
		>
			<AssistantPanel bare />
		</MorphPopover>
	);
}
