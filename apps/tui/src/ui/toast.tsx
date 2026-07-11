/* @jsxImportSource @opentui/react */
// App-wide toast surface. Any tab calls useToast().notify(message, variant) to
// flash a transient status line; the host renders the most recent few at the
// bottom of the screen and auto-expires them. Built on termcn's StatusMessage so
// toasts match the rest of the UI. This is the shared "error/toast surface" the
// foundation provides - tabs should surface fetch failures and action results
// here rather than rolling their own banners.

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import {
	StatusMessage,
	type StatusVariant,
} from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";

export interface Toast {
	id: number;
	message: string;
	variant: StatusVariant;
}

interface ToastContextValue {
	dismiss: (id: number) => void;
	notify: (message: string, variant?: StatusVariant) => void;
	toasts: Toast[];
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_TTL_MS = 4000;
const MAX_TOASTS = 4;

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const dismiss = useCallback((id: number) => {
		setToasts((list) => list.filter((t) => t.id !== id));
	}, []);

	const notify = useCallback(
		(message: string, variant: StatusVariant = "info") => {
			const id = nextId++;
			setToasts((list) =>
				[...list, { id, message, variant }].slice(-MAX_TOASTS)
			);
			setTimeout(() => dismiss(id), TOAST_TTL_MS);
		},
		[dismiss]
	);

	const value = useMemo<ToastContextValue>(
		() => ({ toasts, notify, dismiss }),
		[toasts, notify, dismiss]
	);

	return (
		<ToastContext.Provider value={value}>{children}</ToastContext.Provider>
	);
}

/** Imperative toast API for tabs. Throws outside ToastProvider. */
export function useToast(): Pick<ToastContextValue, "notify"> {
	const ctx = useContext(ToastContext);
	if (!ctx) {
		throw new Error("useToast must be used within a ToastProvider");
	}
	return { notify: ctx.notify };
}

/** Bottom-anchored toast stack. Mount once near the root (App renders it). */
export function ToastHost() {
	const ctx = useContext(ToastContext);
	const theme = useTheme();
	if (!ctx || ctx.toasts.length === 0) {
		return null;
	}
	return (
		<box
			backgroundColor={theme.colors.background}
			flexDirection="column"
			gap={0}
			paddingLeft={1}
			paddingRight={1}
		>
			{ctx.toasts.map((toast) => (
				<StatusMessage key={toast.id} variant={toast.variant}>
					{toast.message}
				</StatusMessage>
			))}
		</box>
	);
}
