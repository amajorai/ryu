import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { createRoot } from "react-dom/client";
import "../../../src/index.css";

// Never inject, replace or mutate the native bridge. Passive observations only:
// all product interactions are performed by the operator through native CUA.
const nativeWindow = getCurrentWindow();
async function record<Value>(kind: string, value: Value) {
	await fetch("/__companion-proof/observation", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ kind, label: nativeWindow.label, value }),
	});
}
async function snapshot(reason: string) {
	try {
		const [position, size, scale, monitor] = await Promise.all([
			nativeWindow.outerPosition(),
			nativeWindow.innerSize(),
			nativeWindow.scaleFactor(),
			currentMonitor(),
		]);
		await record("geometry", {
			reason,
			position,
			size,
			scale,
			monitor,
			viewport: { width: innerWidth, height: innerHeight },
			logical: {
				x: position.x / scale,
				y: position.y / scale,
				width: size.width / scale,
				height: size.height / scale,
			},
		});
	} catch (error) {
		await record(
			"geometry-error",
			error instanceof Error ? error.message : String(error)
		);
	}
}
window.addEventListener("error", (event) => {
	void record("pageerror", event.message);
});
window.addEventListener("unhandledrejection", (event) => {
	void record("unhandledrejection", String(event.reason));
});
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing native Companion fixture root");
}
if (nativeWindow.label === "companion") {
	// Obtain native initial 400x80 geometry before React starts its sizing bridge.
	await snapshot("before-production-mount");
	await nativeWindow.onResized(() => {
		void snapshot("native-resized");
	});
	await nativeWindow.onMoved(() => {
		void snapshot("native-moved");
	});
	const { default: App } = await import("../../../src/App.tsx");
	createRoot(root).render(<App hostSurface="desktop" />);
	requestAnimationFrame(() => {
		void snapshot("after-production-mount");
	});
} else {
	// The compiled host owns the real hotkey and creates the Companion window.
	// Avoid unrelated MainApp initialization in this isolated Companion proof.
	createRoot(root).render(
		<main className="p-6">
			<h1>Companion native proof host</h1>
			<p>
				Open Companion with its native shortcut. Use the overlay controls to
				inspect consent, answers and desktop actions.
			</p>
		</main>
	);
}
