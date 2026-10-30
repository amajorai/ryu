import { toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	DEFAULT_SCALE,
	SCALE_MAX,
	SCALE_MIN,
} from "@/src/hooks/useThemePreset.ts";
import {
	getConsoleBufferText,
	isConsoleCaptureActive,
} from "@/src/lib/console-buffer.ts";
import { getCrashRoute } from "@/src/lib/crash-context.ts";
import { isTauriReady } from "@/src/lib/tauri-ready.ts";
import { STORAGE_KEYS } from "@/src/lib/themes/presets.ts";

export const isMac =
	"navigator" in globalThis && navigator.userAgent.includes("Mac");
export const mod = isMac ? "⌘" : "Ctrl";

export function readScale(): number {
	return Number(
		localStorage.getItem(STORAGE_KEYS.scale) ?? String(DEFAULT_SCALE)
	);
}

export function clampScale(value: number): number {
	return Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));
}
export function canEditSelection(): boolean {
	const active = document.activeElement;
	if (
		active instanceof HTMLInputElement ||
		active instanceof HTMLTextAreaElement
	) {
		const start = active.selectionStart;
		const end = active.selectionEnd;
		if (isNativeNumber(start) && isNativeNumber(end)) {
			return start !== end;
		}
	}
	const sel = window.getSelection();
	return Boolean(sel && !sel.isCollapsed && sel.toString().length > 0);
}

export function isEditableTarget(
	target: EventTarget | null
): target is HTMLElement {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	if (target.isContentEditable) {
		return true;
	}
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export async function toggleDevtools(): Promise<void> {
	if (!isTauriReady()) {
		toast.info("DevTools are only available in the desktop app.");
		return;
	}
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("toggle_devtools");
	} catch {
		toast.error("Couldn't open DevTools in this build.");
	}
}

export async function captureViewportPng(): Promise<Blob | null> {
	try {
		const { default: html2canvas } = await import("html2canvas-pro");
		const canvas = await html2canvas(document.body, {
			backgroundColor: null,
			logging: false,
			scale: Math.min(window.devicePixelRatio || 1, 2),
			useCORS: true,
			windowWidth: window.innerWidth,
			windowHeight: window.innerHeight,
			x: window.scrollX,
			y: window.scrollY,
			width: window.innerWidth,
			height: window.innerHeight,
		});
		return await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((blob) => resolve(blob), "image/png");
		});
	} catch {
		return null;
	}
}

export async function copyScreenshotToClipboard(blob: Blob): Promise<boolean> {
	try {
		await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
		return true;
	} catch {
		return false;
	}
}

export function buildBugReportContext(): string {
	const route = getCrashRoute();
	const lines = [
		"Ryu bug report context",
		`Version: ${import.meta.env.VITE_APP_VERSION ?? "dev"}`,
		`Route: ${route ? `${route.title} (${route.path})` : "(unknown)"}`,
		`URL: ${window.location.href}`,
		`Time: ${new Date().toISOString()}`,
	];
	if (isConsoleCaptureActive()) {
		const consoleText = getConsoleBufferText();
		if (consoleText) {
			lines.push("", "--- Recent console ---", consoleText.slice(-4000));
		}
	}
	return lines.join("\n");
}
