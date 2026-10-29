"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Eye, EyeOff } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

export const SENSITIVE_MASK = "••••••••";

const SensitiveVisibility = createContext({ revealed: false, revision: 0 });

/** Temporary display preferences; never persist a reveal across pages or reloads. */
export function SensitiveDataScope({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	const [visibility, setVisibility] = useState({
		revealed: false,
		revision: 0,
	});
	useEffect(() => {
		const hide = () =>
			setVisibility((current) => ({
				revealed: false,
				revision: current.revision + 1,
			}));
		const onVisibilityChange = () => {
			if (document.hidden) {
				hide();
			}
		};
		window.addEventListener("blur", hide);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			window.removeEventListener("blur", hide);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, []);
	return (
		<SensitiveVisibility.Provider value={visibility}>
			<div className={cn("flex justify-end", className)}>
				<SensitiveRevealButton
					label="all sensitive values"
					onToggle={() =>
						setVisibility((current) => ({
							revealed: !current.revealed,
							revision: current.revision + 1,
						}))
					}
					revealed={visibility.revealed}
					showLabel
				/>
			</div>
			{children}
		</SensitiveVisibility.Provider>
	);
}

export function useSensitiveValue(value: string | null | undefined) {
	const visibility = useContext(SensitiveVisibility);
	const [override, setOverride] = useState<{
		value: typeof value;
		revision: number;
		revealed: boolean;
	} | null>(null);
	useEffect(() => {
		const hide = () =>
			setOverride({ value, revision: visibility.revision, revealed: false });
		const onVisibilityChange = () => {
			if (document.hidden) {
				hide();
			}
		};
		window.addEventListener("blur", hide);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			window.removeEventListener("blur", hide);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [value, visibility.revision]);
	const revealed =
		override?.revision === visibility.revision
			? override.value === value && override.revealed
			: visibility.revealed;
	return {
		revealed,
		toggle: () =>
			setOverride({
				value,
				revision: visibility.revision,
				revealed: !revealed,
			}),
	};
}

export function SensitiveRevealButton({
	label,
	revealed,
	onToggle,
	showLabel = false,
	tabIndex,
}: {
	label: string;
	revealed: boolean;
	onToggle: () => void;
	showLabel?: boolean;
	tabIndex?: number;
}) {
	const tl = useLiteralMessages();
	return (
		<Button
			aria-label={
				revealed
					? tl("Hide {label}", { label })
					: tl("Reveal {label}", { label })
			}
			aria-pressed={revealed}
			className="shrink-0 self-start"
			onClick={(event) => {
				event.stopPropagation();
				onToggle();
			}}
			onPointerDown={(event) => event.stopPropagation()}
			size="sm"
			tabIndex={tabIndex}
			type="button"
			variant="ghost"
		>
			{revealed ? (
				<EyeOff aria-hidden="true" className="size-4" />
			) : (
				<Eye aria-hidden="true" className="size-4" />
			)}
			{showLabel ? (revealed ? tl("Hide all") : tl("Reveal all")) : null}
		</Button>
	);
}

/** Hidden values are omitted from text, titles and accessible labels. */
export function SensitiveValue({
	value,
	label,
	className,
	renderValue,
}: {
	value: string | null | undefined;
	label: string;
	className?: string;
	renderValue?: (display: string) => ReactNode;
}) {
	const { revealed, toggle } = useSensitiveValue(value);
	const display = value ? (revealed ? value : SENSITIVE_MASK) : "—";
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
			<span className="min-w-0 flex-1">
				{renderValue ? (
					renderValue(display)
				) : (
					<span className="break-all font-mono">{display}</span>
				)}
			</span>
			{value ? (
				<SensitiveRevealButton
					label={label}
					onToggle={toggle}
					revealed={revealed}
				/>
			) : null}
		</span>
	);
}
