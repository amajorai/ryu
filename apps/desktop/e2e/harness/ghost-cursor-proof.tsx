import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ghostCursorHueFor } from "../../../island/src/main/control-protocol.ts";
import GHOST_CURSOR_OVERLAY_HTML from "../../../island/src/main/ghost-cursor-overlay.html?raw";
import proofStyles from "./ghost-cursor-proof.module.css";

const FADE_AFTER_MS = 2400;

const CURSOR_IDENTITY = {
	agentId: "@ryu/codex",
	agentName: "Codex",
	agentTitle: "Computer-use agent",
	sessionTitle:
		"Polish Shadow’s computer-use cursor with a clear session title and agent identity",
	avatarEmoji: "✦",
};
const CURSOR_HUE = ghostCursorHueFor(CURSOR_IDENTITY, "proof");

interface GhostOverlayHooks {
	__ghost?: (
		phase: string,
		x: number,
		y: number,
		hue: number,
		intent: string,
		identity: typeof CURSOR_IDENTITY
	) => void;
}

function StatusRow({ label, value }: { label: string; value: string }) {
	return (
		<div className={proofStyles.fixture1}>
			<span className={proofStyles.fixture2}>{label}</span>
			<span className={proofStyles.fixture3}>{value}</span>
		</div>
	);
}

function GhostCursorProof() {
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [faded, setFaded] = useState(false);
	const [replay, setReplay] = useState(0);

	useEffect(() => {
		if (replay === 0) {
			return;
		}
		const overlay = frameRef.current?.contentWindow;
		overlay?.__ghost?.(
			"move",
			390,
			166,
			CURSOR_HUE,
			"Click “Send”",
			CURSOR_IDENTITY
		);
		overlay?.__ghost?.(
			"down",
			390,
			166,
			CURSOR_HUE,
			"Click “Send”",
			CURSOR_IDENTITY
		);
		setFaded(false);
		const timer = window.setTimeout(() => setFaded(true), FADE_AFTER_MS);
		return () => window.clearTimeout(timer);
	}, [replay]);

	return (
		<main className={proofStyles.fixture4} data-testid="ghost-cursor-proof">
			<div className={proofStyles.fixture5}>
				<div className={proofStyles.fixture6}>
					<div aria-hidden="true" className={proofStyles.fixture7}>
						➤
					</div>
					<div>
						<div className={proofStyles.fixture8}>
							GHOST MCP · VERIFICATION PROOF
						</div>
						<h1 className={proofStyles.fixture9}>
							Visible computer-use cursor
						</h1>
					</div>
				</div>

				<p className={proofStyles.fixture10}>
					The MCP action event carries a short intent to the click-through
					Island overlay. The cursor lands on the target, gives a click ripple,
					and fades after the action instead of competing with the user’s
					pointer.
				</p>

				<section
					aria-label="Ghost cursor live preview"
					className={proofStyles.fixture11}
				>
					<div className={proofStyles.fixture12}>
						<div>
							<h2 className={proofStyles.fixture13}>Live action preview</h2>
							<div className={proofStyles.fixture14}>
								Synthetic event: ghost_click → target “Send”
							</div>
						</div>
						<button
							className={proofStyles.fixture15}
							data-testid="ghost-cursor-replay"
							onClick={() => setReplay((value) => value + 1)}
						>
							Replay click
						</button>
					</div>

					<div
						className={proofStyles.fixture16}
						data-testid="ghost-cursor-preview"
					>
						<div className={proofStyles.fixture17}>
							Target app · Send message
						</div>
						<button className={proofStyles.fixture18}>Send</button>
						<iframe
							aria-label="Live Ghost computer-use cursor"
							className={proofStyles.fixture19}
							data-testid="ghost-cursor-frame"
							onLoad={() => setReplay((value) => value + 1)}
							ref={frameRef}
							sandbox="allow-scripts allow-same-origin"
							srcDoc={GHOST_CURSOR_OVERLAY_HTML}
							title="Live Ghost computer-use cursor"
						/>
					</div>
					<div
						aria-live="polite"
						className={proofStyles.fixture20}
						data-testid="ghost-cursor-state"
					>
						{faded
							? `Faded after ${FADE_AFTER_MS / 1000}s idle`
							: "Visible · agent avatar · session title · current action"}
					</div>
				</section>

				<section
					aria-label="Ghost cursor contract"
					className={proofStyles.fixture21}
				>
					<StatusRow label="Intent field" value={"Click “Send”"} />
					<StatusRow label="Cursor identity" value="Codex · session title" />
					<StatusRow label="Pointer surface" value="click-through" />
					<StatusRow label="Idle fade" value="2.4s + 420ms" />
					<StatusRow label="Physical cursor" value="unchanged" />
				</section>
			</div>
		</main>
	);
}

declare global {
	interface Window extends GhostOverlayHooks {
		__ghostCursorProofRoot?: ReturnType<typeof createRoot>;
	}
}

const proofRoot = document.getElementById("root");
if (proofRoot) {
	const proofWindow = window;
	const root = proofWindow.__ghostCursorProofRoot ?? createRoot(proofRoot);
	proofWindow.__ghostCursorProofRoot = root;
	root.render(<GhostCursorProof />);
}
