import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { MentionToken } from "@ryu/blocks/desktop/agent-elements/mention-token.tsx";
import {
	ComposerEditor,
	type ComposerMentionItem,
} from "@ryu/ui/components/editor/composer-editor.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const INITIAL_MARKDOWN = "";
const COMPOSER_PLACEHOLDER =
	"Paste ChatGPT mention links, then copy the resolved mentions back as Markdown.";
const MENTION_ITEMS: ComposerMentionItem[] = [
	{
		id: "project-1",
		kind: "app-item",
		label: "Ryu Pricing Economics",
		ownerId: "com.ryu.sites",
	},
	{ id: "conversation-1", kind: "chat", label: "Captcha answer check" },
	{ id: "hotline", kind: "integration", label: "Hotline" },
	{ id: "github", kind: "plugin", label: "GitHub" },
	{ id: "thermos", kind: "skill", label: "thermos" },
];

function ComposerMarkdownProof() {
	const [richMode, setRichMode] = useState(false);
	const [markdown, setMarkdown] = useState(INITIAL_MARKDOWN);

	return (
		<main className="dark min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-3xl">
				<header className="mb-8 flex flex-wrap items-start justify-between gap-5">
					<div>
						<p className="font-medium text-primary text-sm uppercase tracking-(--tracking-section)">
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-4xl text-white tracking-tight">
							Rich Markdown composer
						</h1>
						<p className="mt-3 max-w-2xl text-muted-foreground">
							The production composer keeps the lightweight textarea by default.
							Turn on the Appearance setting below to mount the shared Plate
							editor for Markdown links, mentions, and common formatting.
						</p>
					</div>
					<div
						className={`rounded-full px-4 py-2 font-semibold text-sm ${richMode ? "bg-success/15 text-success" : "bg-muted-foreground/10 text-muted-foreground"}`}
						data-testid="mode-status"
					>
						{richMode ? "RICH MODE ON" : "LIGHTWEIGHT MODE"}
					</div>
				</header>

				<section className="rounded-3xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl">
					<div className="flex items-center justify-between gap-4 border-white/10 border-b pb-4">
						<div>
							<h2 className="font-semibold text-lg text-white">Appearance</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								Settings → Appearance → Interface
							</p>
						</div>
						<label className="flex cursor-pointer items-center gap-3 font-medium text-sm">
							<span>Rich Markdown composer</span>
							<input
								aria-label="Rich Markdown composer"
								checked={richMode}
								onChange={(event) => setRichMode(event.target.checked)}
								type="checkbox"
							/>
						</label>
					</div>

					<div className="mt-5 rounded-2xl border border-primary/20 bg-background/70 p-4">
						<p className="mb-3 font-semibold text-primary text-xs uppercase tracking-(--tracking-section)">
							Composer
						</p>
						{richMode ? (
							<ComposerEditor
								markdown={markdown}
								mentionItems={MENTION_ITEMS}
								mentionRenderer={(label) => (
									<MentionToken>{label}</MentionToken>
								)}
								onChange={setMarkdown}
								placeholder={COMPOSER_PLACEHOLDER}
							/>
						) : (
							<InputBar
								mentionItems={MENTION_ITEMS}
								onChange={setMarkdown}
								onSend={() => undefined}
								onStop={() => undefined}
								placeholder={COMPOSER_PLACEHOLDER}
								status="ready"
								value={markdown}
							/>
						)}
					</div>

					<div className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
						<ProofNote
							label="Paste"
							value="Mention links resolve to local items"
						/>
						<ProofNote
							label="Copy"
							value="Selected mentions copy as Markdown links"
						/>
						<ProofNote label="Links" value="Ordinary web links stay links" />
					</div>
					<pre
						className="mt-5 overflow-auto rounded-xl border border-white/10 bg-black/20 p-3 text-muted-foreground text-xs"
						data-testid="serialized-markdown"
					>
						{markdown}
					</pre>
					<label
						className="mt-4 block font-medium text-primary text-xs uppercase tracking-wide"
						htmlFor="copied-markdown"
					>
						Clipboard round trip
					</label>
					<textarea
						className="mt-2 min-h-20 w-full resize-y rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
						id="copied-markdown"
						placeholder="Copy the pasted references, then paste the Markdown here"
					/>
				</section>
			</div>
		</main>
	);
}

function ProofNote({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-xl border border-white/10 bg-black/15 p-3">
			<div className="font-medium text-primary text-xs uppercase tracking-wide">
				{label}
			</div>
			<div className="mt-1 text-muted-foreground leading-5">{value}</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<ComposerMarkdownProof />);
