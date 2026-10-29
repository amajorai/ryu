/* @jsxImportSource @opentui/react */
// App-wide toast surface. Any tab calls useToast().notify(message, variant) to
// flash a transient status line. The host floats in the top-right corner above
// the panes (it never takes a layout row, so panes and the status bar do not
// reflow), shows the newest few toasts with a severity bar on a raised
// background, folds repeats into an "×N" count and summarises the overflow as
// "+N more". Lifetimes scale with severity, and clicking a toast dismisses it.
// Uses termcn's StatusMessage icons and Spinner so toasts match the rest of the
// UI (drawn here so every icon and the text stay legible on the raised
// background in light and dark themes). This is
// the shared "error/toast surface" the foundation provides - tabs should surface
// fetch failures and action results here rather than rolling their own banners.

import { useTerminalDimensions } from "@opentui/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { StatusVariant } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../i18n/translate.ts";

export interface Toast {
	/** How many identical notifications this toast stands for. */
	count: number;
	id: number;
	message: string;
	variant: StatusVariant;
}

/** Per-call overrides for a single notification. */
export interface NotifyOptions {
	/** Lifetime for this toast instead of its severity default (e.g. a 2s "copied" flash). */
	ttlMs?: number;
}

interface ToastContextValue {
	dismiss: (id: number) => void;
	/** Shows (or re-counts) a toast and returns its id for an early dismiss. */
	notify: (
		message: string,
		variant?: StatusVariant,
		options?: NotifyOptions
	) => number;
	toasts: Toast[];
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Lifetime per severity: problems stay up long enough to be read. */
export const TOAST_TTL_MS: Readonly<Record<StatusVariant, number>> = {
	info: 3000,
	success: 3000,
	pending: 3000,
	loading: 4000,
	warning: 6000,
	error: 8000,
};
const MAX_TOASTS = 4;
/** Toasts drawn at once; the rest collapse into a "+N more" line. */
export const VISIBLE_TOASTS = 3;
/** Widest a toast grows on wide terminals before its message wraps. */
const TOAST_MAX_COLUMNS = 60;
/** Narrowest stack on small terminals (it may then cover half the screen). */
const TOAST_MIN_COLUMNS = 28;
/** Columns around a message: left bar, its padding, the icon, right padding. */
const TOAST_CHROME_COLUMNS = 4;
/** Rows kept clear: the row above the stack and the status bar below it. */
const TOAST_RESERVED_ROWS = 2;

/** Matches termcn StatusMessage's glyphs; loading renders a Spinner instead. */
const TOAST_ICONS: Readonly<Record<Exclude<StatusVariant, "loading">, string>> =
	{
		error: "✗",
		info: "ℹ",
		pending: "○",
		success: "✓",
		warning: "⚠",
	};

let nextId = 1;

type ThemeColors = ReturnType<typeof useTheme>["colors"];

function toastColor(colors: ThemeColors, variant: StatusVariant): string {
	switch (variant) {
		case "success":
			return colors.success;
		case "error":
			return colors.error;
		case "warning":
			return colors.warning;
		case "loading":
			return colors.primary;
		case "pending":
			return colors.mutedForeground;
		default:
			return colors.info;
	}
}

export function ToastProvider({
	children,
	ttl,
}: {
	children: ReactNode;
	/** Overrides per-severity lifetimes (tests use short values). */
	ttl?: Partial<Record<StatusVariant, number>>;
}) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const toastsRef = useRef<Toast[]>([]);
	const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
	const ttlRef = useRef(ttl);
	ttlRef.current = ttl;

	const commit = useCallback((next: Toast[]) => {
		toastsRef.current = next;
		setToasts(next);
	}, []);

	const clearTimer = useCallback((id: number) => {
		const timer = timers.current.get(id);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.current.delete(id);
		}
	}, []);

	const dismiss = useCallback(
		(id: number) => {
			clearTimer(id);
			commit(toastsRef.current.filter((t) => t.id !== id));
		},
		[clearTimer, commit]
	);

	const schedule = useCallback(
		(id: number, variant: StatusVariant, ttlMs?: number) => {
			clearTimer(id);
			const lifetime =
				ttlMs ?? ttlRef.current?.[variant] ?? TOAST_TTL_MS[variant];
			timers.current.set(
				id,
				setTimeout(() => dismiss(id), lifetime)
			);
		},
		[clearTimer, dismiss]
	);

	const notify = useCallback(
		(
			message: string,
			variant: StatusVariant = "info",
			options?: NotifyOptions
		) => {
			const list = toastsRef.current;
			const repeat = list.find(
				(t) => t.message === message && t.variant === variant
			);
			if (repeat) {
				commit(
					list.map((t) =>
						t.id === repeat.id ? { ...t, count: t.count + 1 } : t
					)
				);
				schedule(repeat.id, variant, options?.ttlMs);
				return repeat.id;
			}
			const id = nextId++;
			const next = [...list, { count: 1, id, message, variant }];
			for (const dropped of next.slice(0, -MAX_TOASTS)) {
				clearTimer(dropped.id);
			}
			commit(next.slice(-MAX_TOASTS));
			schedule(id, variant, options?.ttlMs);
			return id;
		},
		[clearTimer, commit, schedule]
	);

	useEffect(() => {
		const pending = timers.current;
		return () => {
			for (const timer of pending.values()) {
				clearTimeout(timer);
			}
			pending.clear();
		};
	}, []);

	const value = useMemo<ToastContextValue>(
		() => ({ toasts, notify, dismiss }),
		[toasts, notify, dismiss]
	);

	return (
		<ToastContext.Provider value={value}>{children}</ToastContext.Provider>
	);
}

/** Imperative toast API for tabs. Throws outside ToastProvider. */
export function useToast(): Pick<ToastContextValue, "notify" | "dismiss"> {
	const ctx = useContext(ToastContext);
	if (!ctx) {
		throw new Error("useToast must be used within a ToastProvider");
	}
	return { notify: ctx.notify, dismiss: ctx.dismiss };
}

/**
 * Floating top-right toast stack, newest first. Mount once as the last child
 * of the root column (App renders it) so it paints above panes and overlays.
 * Its width tracks the terminal and its height stops above the status bar.
 */
export function ToastHost() {
	const ctx = useContext(ToastContext);
	const theme = useTheme();
	const { width, height } = useTerminalDimensions();
	if (!ctx || ctx.toasts.length === 0) {
		return null;
	}
	const availableRows = Math.max(1, height - TOAST_RESERVED_ROWS);
	const shown = ctx.toasts
		.slice(-Math.min(VISIBLE_TOASTS, availableRows))
		.reverse();
	const hidden = ctx.toasts.length - shown.length;
	const columns = Math.min(
		TOAST_MAX_COLUMNS,
		Math.max(TOAST_MIN_COLUMNS, Math.floor(width / 2)),
		Math.max(1, width - 4)
	);
	const messageColumns = Math.max(1, columns - TOAST_CHROME_COLUMNS);
	return (
		<box
			flexDirection="column"
			// Never squeezed by tall content above: a shrunk stack drew its last
			// toast over the status bar row.
			flexShrink={0}
			gap={0}
			maxHeight={availableRows}
			overflow="hidden"
			position="absolute"
			right={2}
			top={1}
			width={columns}
			zIndex={30}
		>
			{shown.map((toast) => {
				const color = toastColor(theme.colors, toast.variant);
				return (
					<box
						backgroundColor={theme.colors.muted}
						border={["left"]}
						borderColor={color}
						borderStyle="heavy"
						flexDirection="row"
						flexShrink={0}
						key={toast.id}
						onMouseDown={() => ctx.dismiss(toast.id)}
						paddingLeft={1}
						paddingRight={1}
					>
						{toast.variant === "loading" ? (
							<Spinner color={color} flexShrink={0} type="dots" />
						) : (
							<text fg={color} flexShrink={0}>
								{TOAST_ICONS[toast.variant]}
							</text>
						)}
						<box paddingLeft={1} width={messageColumns}>
							<text fg={theme.colors.foreground} wrapMode="word">
								{toast.count > 1
									? `${toast.message} ×${toast.count}`
									: toast.message}
							</text>
						</box>
					</box>
				);
			})}
			{hidden > 0 ? (
				<box
					backgroundColor={theme.colors.muted}
					flexShrink={0}
					paddingLeft={3}
				>
					<text fg={theme.colors.mutedForeground}>
						{tf("+{hidden} more", { hidden })}
					</text>
				</box>
			) : null}
		</box>
	);
}
