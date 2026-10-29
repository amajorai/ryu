import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { Profiler, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

// Streams a long reply (prose, then a 300-line TypeScript block) into the real
// chat Markdown and measures React render time with a Profiler. Chunks are
// driven with flushSync and yield through a MessageChannel, not timers, so the
// numbers stay deterministic even when the pane is hidden and timers throttle.
// Run `await window.__runStreamProof()`; `?chunk=200` shortens the run. To
// compare against another revision, copy its markdown.tsx beside the real one
// and import it here.

const CODE = Array.from(
	{ length: 300 },
	(_, index) =>
		`export function handler${index}(input: string): Promise<number> { return fetch("/api/${index}").then((r) => r.json()); }`
).join("\n");

const REPLY = `Here’s the refactor — it keeps the “same” public API.\n\n${Array.from(
	{ length: 12 },
	(_, index) =>
		`Paragraph ${index + 1} explains one part of the change in plain words.`
).join(
	"\n\n"
)}\n\nCall \`handler0()\` first.\n\n| Name | Lines |\n| --- | --- |\n| handlers | 300 |\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\nThat’s all.`;

const CHUNK =
	Number(new URLSearchParams(window.location.search).get("chunk")) || 40;

interface ProofStats {
	chunks: number;
	commits: number;
	maxCommitMs: number;
	renderMs: number;
	wallMs: number;
}

declare global {
	interface Window {
		__runStreamProof?: () => Promise<ProofStats>;
	}
}

const channel = new MessageChannel();
function yieldToHost(): Promise<void> {
	return new Promise((resolve) => {
		channel.port1.onmessage = () => resolve();
		channel.port2.postMessage(null);
	});
}

let setLengthExternal: ((length: number) => void) | null = null;
const profile = { commits: 0, maxCommitMs: 0, renderMs: 0 };
const slowCommits: { length: number; ms: number; phase: string }[] = [];
Reflect.set(window, "__slowCommits", slowCommits);

function StreamProof() {
	const [length, setLength] = useState(0);
	setLengthExternal = setLength;
	const done = length === REPLY.length;
	return (
		<main className="mx-auto max-w-3xl space-y-4 p-6">
			<p className="text-muted-foreground text-xs" data-testid="stream-stats">
				{done ? "done" : `streaming ${length}/${REPLY.length}`}
			</p>
			<Profiler
				id="markdown"
				onRender={(_id, phase, actualDuration) => {
					slowCommits.push({ length, ms: Math.round(actualDuration), phase });
					slowCommits.sort((a, b) => b.ms - a.ms);
					slowCommits.length = Math.min(slowCommits.length, 8);
					profile.commits++;
					profile.renderMs += actualDuration;
					profile.maxCommitMs = Math.max(profile.maxCommitMs, actualDuration);
				}}
			>
				<Markdown
					content={REPLY.slice(0, length)}
					isStreaming={length > 0 && !done}
					wideBlocks
				/>
			</Profiler>
		</main>
	);
}

window.__runStreamProof = async () => {
	profile.commits = 0;
	profile.maxCommitMs = 0;
	profile.renderMs = 0;
	const started = performance.now();
	let chunks = 0;
	for (let length = CHUNK; ; length += CHUNK) {
		const next = Math.min(REPLY.length, length);
		flushSync(() => setLengthExternal?.(next));
		chunks++;
		await yieldToHost();
		if (next === REPLY.length) {
			break;
		}
	}
	return {
		chunks,
		commits: profile.commits,
		maxCommitMs: Math.round(profile.maxCommitMs),
		renderMs: Math.round(profile.renderMs),
		wallMs: Math.round(performance.now() - started),
	};
};

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<StreamProof />);
}
