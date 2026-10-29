import proofStyles from "./node-layer-story.module.css";
// Standalone browser story for the REAL `NodeLayerMenu` — the submenu shell every
// layer of the node selector renders through (services, Chat, the
// run-alongside engines, Audio + its nested voice picker, Voice Recognition,
// Speech Processing, and sandbox backend).
//
// The component is purely prop-driven (it owns layout + pending state and nothing
// else), so the whole matrix is reachable without Core, Tauri, or seed data. This
// covers the three things static checks cannot: that a submenu opens at all, that
// the Audio → Voice picker is usable THREE levels deep, and that a layer with no
// actions and no options (a read-only running service) still renders its header
// instead of an empty popup.
//
// HARNESS LIMIT: like the other stories, this bare harness ships no Tailwind
// plugin, so utility classes are never generated. This asserts STRUCTURE and
// interaction, not visual styling.

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { createRoot, type Root } from "react-dom/client";
import {
	type LayerOption,
	NodeLayerMenu,
	startStopAction,
} from "../../src/components/shell/NodeLayerMenu.tsx";
import "../../src/index.css";

const noop = () => undefined;

const CHAT_INSTALLED: LayerOption[] = [
	{
		name: "llamacpp",
		label: "llama.cpp",
		active: true,
		detail: "b9670",
		select: noop,
	},
	{
		name: "ollama",
		label: "Ollama",
		detail: "0.5.1",
		select: noop,
		uninstall: noop,
	},
];

const CHAT_AVAILABLE: LayerOption[] = [
	{ name: "vllm", label: "vLLM", detail: "0.7.0", select: noop },
	{
		name: "sglang",
		label: "SGLang",
		disabled: true,
		disabledReason: "unsupported here",
		select: noop,
	},
];

const VOICE_RECOGNITION_INSTALLED: LayerOption[] = [
	{
		name: "whispercpp",
		label: "whisper.cpp",
		active: true,
		detail: "142 MB",
		select: noop,
		uninstall: noop,
	},
	{ name: "parakeet", label: "Parakeet v3", select: noop, uninstall: noop },
];

const VOICES: LayerOption[] = [
	{ name: "af_heart", label: "af_heart", active: true, select: noop },
	{ name: "am_puck", label: "am_puck", select: noop },
];

const SPEECH_PROCESSING_STYLES: LayerOption[] = [
	{ name: "casual", label: "casual", select: noop },
	{ name: "semi-casual", label: "semi-casual", select: noop },
	{ name: "semi-formal", label: "semi-formal", active: true, select: noop },
	{ name: "formal", label: "formal", select: noop },
];

function Story() {
	return (
		<div className={proofStyles.fixture1}>
			<DropdownMenu>
				<DropdownMenuTrigger>Node</DropdownMenuTrigger>
				{/* Same width the node selector uses, so the story's trigger rows are
				    laid out exactly as they are in the app. */}
				<DropdownMenuContent className="w-72">
					{/* Singleton service: actions only, no swap list. */}
					<NodeLayerMenu
						actions={[
							startStopAction(true, noop),
							{
								id: "update",
								label: "Update",
								tone: "warning",
								run: noop,
							},
						]}
						caption="Running · 2.1 GB · 4%"
						currentLabel="Core"
						label="Core"
						running={true}
						trailing="2.1 GB · 4%"
						version="0.0.9"
					/>
					{/* Read-only running service: header only, no body at all. */}
					<NodeLayerMenu
						caption="Running"
						currentLabel="Island"
						label="Island"
						running={true}
					/>
					{/* Swap layer: no start/stop, tick on the active engine. */}
					<NodeLayerMenu
						available={CHAT_AVAILABLE}
						caption="Resident Chat · 2.1 GB"
						currentLabel="llama.cpp"
						installed={CHAT_INSTALLED}
						label="Chat"
						running={true}
						version="b9670"
					/>
					{/* Toggle layer: independent engines, tick means running. */}
					<NodeLayerMenu
						caption="1 of 2 running"
						currentLabel="whisper.cpp"
						installed={VOICE_RECOGNITION_INSTALLED}
						label="Voice Recognition"
						running={true}
						selectionMode="toggle"
					/>
					{/* Post-ASR cleanup is its own model layer, independent of the
					    Voice Recognition engine that produced the raw transcript. */}
					<NodeLayerMenu
						caption="Optional cleanup · 484 MB · local"
						currentLabel="S1-mini by Superwhisper"
						installed={[
							{
								name: "s1-mini",
								label: "S1-mini by Superwhisper",
								active: true,
								detail: "s1-mini-q4_k_m",
								select: noop,
							},
						]}
						label="Speech Processing"
						running={true}
					>
						<NodeLayerMenu
							currentLabel="semi-formal"
							installed={SPEECH_PROCESSING_STYLES}
							label="Style"
						/>
					</NodeLayerMenu>
					{/* Nested second dimension: a Voice picker inside the Audio layer. */}
					<NodeLayerMenu
						caption="Speaks as af_heart"
						currentLabel="Kokoro"
						installed={[
							{
								name: "kokoro",
								label: "Kokoro",
								active: true,
								detail: "2 voices",
								select: noop,
							},
						]}
						label="Audio"
						running={true}
					>
						<NodeLayerMenu
							currentLabel="af_heart"
							installed={VOICES}
							label="Voice"
						/>
					</NodeLayerMenu>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

declare global {
	interface Window {
		__ryuNodeLayerStoryRoot?: Root;
	}
}
const root = document.getElementById("root");
if (root) {
	const storyWindow = window;
	const appRoot = storyWindow.__ryuNodeLayerStoryRoot ?? createRoot(root);
	storyWindow.__ryuNodeLayerStoryRoot = appRoot;
	appRoot.render(<Story />);
}
