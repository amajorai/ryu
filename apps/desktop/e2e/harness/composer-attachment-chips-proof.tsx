import { ChatDisplayPrefsProvider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import type { AttachedImage } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const COLORS = ["#f97316", "#22c55e", "#6366f1", "#ec4899"];

function swatch(color: string): string {
	const canvas = document.createElement("canvas");
	canvas.width = 24;
	canvas.height = 24;
	const context = canvas.getContext("2d");
	if (context) {
		context.fillStyle = color;
		context.fillRect(0, 0, 24, 24);
	}
	return canvas.toDataURL("image/png");
}

function Composer({ name, rich }: { name: string; rich: boolean }) {
	const [value, setValue] = useState("");
	const [images, setImages] = useState<AttachedImage[]>([]);
	const [count, setCount] = useState(0);
	const addImage = () => {
		const next = count + 1;
		setCount(next);
		setImages((prev) => [
			...prev,
			{
				filename: `photo-${next}.png`,
				id: `img-${next}`,
				mimeType: "image/png",
				url: swatch(COLORS[(next - 1) % COLORS.length] ?? "#f97316"),
			},
		]);
	};
	const addFile = () => {
		const next = count + 1;
		setCount(next);
		setImages((prev) => [
			...prev,
			{
				filename: `notes-${next}.txt`,
				id: `txt-${next}`,
				mimeType: "text/plain",
				url: "data:text/plain;base64,aGVsbG8=",
			},
		]);
	};
	return (
		<ChatDisplayPrefsProvider value={{ markdownComposer: rich }}>
			<section
				className="space-y-3 rounded-2xl border border-border p-4"
				data-testid={name}
			>
				<div className="flex gap-2">
					<button
						className="rounded border px-2 py-1 text-sm"
						onClick={addImage}
						type="button"
					>
						Add image
					</button>
					<button
						className="rounded border px-2 py-1 text-sm"
						onClick={addFile}
						type="button"
					>
						Add text file
					</button>
				</div>
				<InputBar
					attachedImages={images}
					onChange={setValue}
					onRemoveImage={(id) =>
						setImages((prev) => prev.filter((image) => image.id !== id))
					}
					onSend={() => undefined}
					onStop={() => undefined}
					placeholder="Describe the edit…"
					status="ready"
					textareaAriaLabel={`${name} composer`}
					value={value}
				/>
				<pre
					className="text-muted-foreground text-xs"
					data-testid={`${name}-draft`}
				>
					{value}
				</pre>
			</section>
		</ChatDisplayPrefsProvider>
	);
}

function Proof() {
	return (
		<main className="mx-auto max-w-2xl space-y-6 bg-background p-8 text-foreground">
			<Composer name="plain" rich={false} />
			<Composer name="rich" rich />
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
