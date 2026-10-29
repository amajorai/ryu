/**
 * Frame-local toast primitive for sandboxed Companion apps.
 *
 * The desktop Sileo wrapper owns a React portal and cannot be mounted inside a
 * null-origin companion frame. The frame still needs the same small feedback
 * contract, though, so the DOM implementation lives here once instead of being
 * copied into every satellite.
 */

import { isNativeText } from "../lib/native-primitive-observation.ts";
export type SandboxToastKind = "error" | "info" | "success" | "warning";

export interface SandboxToastOptions {
	description?: string;
	duration?: number;
	title: string;
}

export type SandboxToastInput = string | SandboxToastOptions;

const CONTAINER_ID = "ryu-sandbox-toast-container";
const DEFAULT_DURATION_MS = 3200;
const EXIT_DURATION_MS = 200;

const BORDER_COLORS = {
	error: "#ef4444",
	info: "#3b82f6",
	success: "#22c55e",
	warning: "#f59e0b",
} satisfies Record<SandboxToastKind, string>;

/** Normalize the two call shapes used by the desktop and companion surfaces. */
export function normalizeSandboxToast(
	input: SandboxToastInput,
	rest?: Omit<SandboxToastOptions, "title">
): SandboxToastOptions {
	if (isNativeText(input)) {
		return { title: input, ...rest };
	}
	return input;
}

function getContainer(): HTMLElement | null {
	if (globalThis.document === undefined) {
		return null;
	}

	const existing = document.getElementById(CONTAINER_ID);
	if (existing) {
		return existing;
	}

	const container = document.createElement("div");
	container.id = CONTAINER_ID;
	container.setAttribute("aria-label", "Notifications");
	container.style.cssText =
		"position:fixed;bottom:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;";
	document.body.appendChild(container);
	return container;
}

function removeToast(element: HTMLElement): void {
	element.style.opacity = "0";
	globalThis.setTimeout(() => element.remove(), EXIT_DURATION_MS);
}

function showToast(
	kind: SandboxToastKind,
	input: SandboxToastInput,
	rest?: Omit<SandboxToastOptions, "title">
): void {
	const options = normalizeSandboxToast(input, rest);
	const container = getContainer();
	if (!(container && options.title.trim())) {
		return;
	}

	const toast = document.createElement("div");
	toast.dataset.ryuToast = kind;
	toast.setAttribute("role", kind === "error" ? "alert" : "status");
	toast.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
	toast.style.cssText = [
		"pointer-events:auto",
		"max-width:22rem",
		"padding:10px 12px",
		"border:1px solid var(--border,#3f3f46)",
		`border-left:3px solid ${BORDER_COLORS[kind]}`,
		"border-radius:10px",
		"background:var(--muted,#18181b)",
		"color:var(--foreground,#fafafa)",
		"font-size:13px",
		"box-shadow:0 8px 24px rgba(0,0,0,.35)",
		"opacity:0",
		"transform:translateY(4px)",
		"transition:opacity .15s ease,transform .15s ease",
	].join(";");

	const title = document.createElement("div");
	title.style.cssText = "font-weight:500";
	title.textContent = options.title;
	toast.appendChild(title);

	if (options.description) {
		const description = document.createElement("div");
		description.style.cssText = "margin-top:2px;opacity:.75;font-size:12px";
		description.textContent = options.description;
		toast.appendChild(description);
	}

	container.appendChild(toast);
	globalThis.requestAnimationFrame?.(() => {
		toast.style.opacity = "1";
		toast.style.transform = "translateY(0)";
	});

	const duration = Math.max(0, options.duration ?? DEFAULT_DURATION_MS);
	if (duration > 0) {
		globalThis.setTimeout(() => removeToast(toast), duration);
	}
}

export const sandboxToast = {
	error: (
		input: SandboxToastInput,
		rest?: Omit<SandboxToastOptions, "title">
	) => showToast("error", input, rest),
	info: (input: SandboxToastInput, rest?: Omit<SandboxToastOptions, "title">) =>
		showToast("info", input, rest),
	message: (
		input: SandboxToastInput,
		rest?: Omit<SandboxToastOptions, "title">
	) => showToast("info", input, rest),
	success: (
		input: SandboxToastInput,
		rest?: Omit<SandboxToastOptions, "title">
	) => showToast("success", input, rest),
	warning: (
		input: SandboxToastInput,
		rest?: Omit<SandboxToastOptions, "title">
	) => showToast("warning", input, rest),
};

/** Alias for callers ported from the desktop's `sileo` API. */
export const sandboxSileo = sandboxToast;
