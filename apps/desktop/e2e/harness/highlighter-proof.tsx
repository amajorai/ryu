import { streamingCodeHighlighter } from "@ryu/blocks/desktop/agent-elements/code-highlighter.ts";
import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
const first = "<script>const answer = 42;</script><button>Hello</button>  \n\n";
const second = `${first}<button>Independent second block</button>  \n\n`;
function App() {
	const [source, setSource] = useState(first);
	const [settled, setSettled] = useState(false);
	return (
		<main className="mx-auto max-w-4xl space-y-6 p-8 text-foreground">
			<button
				className="rounded-md border px-4 py-2"
				onClick={() => document.documentElement.classList.toggle("dark")}
				type="button"
			>
				Toggle dark appearance
			</button>
			<h1 className="font-semibold text-xl">Code in a streaming reply</h1>
			<p className="text-muted-foreground">
				Independent blocks retain their exact source and syntax colors.
			</p>
			<section data-testid="first">
				<Markdown content={`\`\`\`html\n${source}\n\`\`\``} isStreaming />
			</section>
			<section data-testid="second">
				<Markdown content={`\`\`\`html\n${second}\n\`\`\``} isStreaming />
			</section>
			<button
				className="rounded-md border px-4 py-2"
				onClick={() => setSource(second)}
				type="button"
			>
				Update first block
			</button>
			<button
				className="rounded-md border px-4 py-2"
				onClick={() => {
					const old = "<aside>Older queued browser source</aside>";
					setSettled(false);
					flushSync(() => setSource(old));
					setSource(second);
					const result = streamingCodeHighlighter.highlight(
						{
							code: old,
							language: "html",
							themes: ["github-light", "github-dark"],
						},
						() => setSettled(true)
					);
					if (result) {
						setSettled(true);
					}
				}}
				type="button"
			>
				Replace queued block with cached source
			</button>
			<output data-testid="queue-settled">
				{settled ? "settled" : "pending"}
			</output>
		</main>
	);
}
const root = document.getElementById("root");
if (!root) {
	throw new Error("missing proof root");
}
createRoot(root).render(<App />);
