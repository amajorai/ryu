// Mount the production in-page Copilot stylesheet and shared InputBar inside a
// shadow root so the browser proof covers the same isolation boundary.

import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { COPILOT_STYLES } from "../../../extension/lib/copilot/styles.ts";
import copilotClasses from "./copilot-composer-story.module.css";

function Story() {
	const [composeDraft, setComposeDraft] = useState("");
	const [sentMessage, setSentMessage] = useState("");
	const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
		null
	);

	useEffect(() => {
		const host = document.getElementById("copilot-host");
		if (!(host instanceof HTMLDivElement)) {
			return;
		}

		const shadow = host.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent = COPILOT_STYLES;
		const container = document.createElement("div");
		shadow.append(style, container);
		setPortalContainer(container);

		return () => shadow.replaceChildren();
	}, []);

	return (
		<>
			<div aria-label="Copilot shadow root" id="copilot-host" />
			<output data-testid="sent-message">{sentMessage}</output>
			{portalContainer
				? createPortal(
						<div className={`dark ${copilotClasses.panel}`}>
							<div className={copilotClasses.head}>
								<span className={copilotClasses.brand}>
									Ryu in-page copilot
								</span>
							</div>
							<div className={copilotClasses.messages}>
								<div className={copilotClasses.empty}>Ask about this page.</div>
							</div>
							<div className={copilotClasses.composer}>
								<InputBar
									className="!px-0 !pb-0"
									compact
									leftActions={null}
									onChange={setComposeDraft}
									onSend={({ content }) => {
										setSentMessage(content);
										setComposeDraft("");
									}}
									onStop={() => undefined}
									placeholder="Ask Ryu about this page…"
									seamless
									status="ready"
									value={composeDraft}
								/>
							</div>
						</div>,
						portalContainer
					)
				: null}
		</>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
