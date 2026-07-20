"use client";

import { cn } from "@ryu/ui/lib/utils";
import {
	type ComponentProps,
	type CSSProperties,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

const DEFAULT_DURATION_MS = 500;
const DIGIT_CELLS = Array.from({ length: 10 }, (_, i) => i);

let supportsRoll: boolean | undefined;

function canAnimate(): boolean {
	if (supportsRoll === undefined) {
		supportsRoll =
			typeof CSS !== "undefined" &&
			typeof CSS.registerProperty === "function" &&
			CSS.supports(
				"transform",
				"translateY(clamp(-1lh, calc((mod(7.5, 10) - 5) * 1lh), 1lh))"
			);
		if (supportsRoll) {
			try {
				CSS.registerProperty({
					name: "--ryu-number-roll-pos",
					syntax: "<number>",
					inherits: true,
					initialValue: "0",
				});
			} catch {
				// Already registered by another mounted copy.
			}
		}
	}
	return supportsRoll;
}

const formatterCache = new Map<string, Intl.NumberFormat>();

function getFormatter(
	locales: Intl.LocalesArgument,
	format: Intl.NumberFormatOptions | undefined
): Intl.NumberFormat {
	const key = `${String(locales)}\u0000${JSON.stringify(format)}`;
	let formatter = formatterCache.get(key);
	if (!formatter) {
		formatter = new Intl.NumberFormat(locales, format);
		formatterCache.set(key, formatter);
	}
	return formatter;
}

interface DigitPart {
	digit: number;
	key: string;
	type: "digit";
}

interface SymbolPart {
	key: string;
	type: "symbol";
	value: string;
}

type Part = DigitPart | SymbolPart;
type RenderedPart = Part & { exiting?: boolean; entered?: boolean };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Splitting Intl parts while preserving right-aligned digit identity is the core odometer behavior.
function toParts(
	value: number,
	formatter: Intl.NumberFormat,
	prefix: string | undefined,
	suffix: string | undefined
): Part[] {
	type Atom =
		| { kind: "integer"; digit: number }
		| { kind: "group"; value: string }
		| { kind: "fraction"; digit: number }
		| { kind: "symbol"; type: string; value: string };
	const atoms: Atom[] = [];
	if (prefix) {
		atoms.push({ kind: "symbol", type: "prefix", value: prefix });
	}
	for (const part of formatter.formatToParts(value)) {
		if (part.type === "integer" || part.type === "fraction") {
			for (const char of part.value) {
				const digit = char.charCodeAt(0) - 48;
				if (digit >= 0 && digit <= 9) {
					atoms.push({ kind: part.type, digit });
				} else {
					atoms.push({ kind: "symbol", type: part.type, value: char });
				}
			}
		} else if (part.type === "group") {
			atoms.push({ kind: "group", value: part.value });
		} else {
			const type =
				part.type === "minusSign" || part.type === "plusSign"
					? "sign"
					: part.type;
			atoms.push({ kind: "symbol", type, value: part.value });
		}
	}
	if (suffix) {
		atoms.push({ kind: "symbol", type: "suffix", value: suffix });
	}

	const counts = new Map<string, number>();
	const nextKey = (type: string) => {
		const count = counts.get(type) ?? 0;
		counts.set(type, count + 1);
		return `${type}:${count}`;
	};
	const parts: Part[] = new Array(atoms.length);
	for (let i = atoms.length - 1; i >= 0; i--) {
		const atom = atoms[i];
		if (!atom) {
			continue;
		}
		if (atom.kind === "integer") {
			parts[i] = { type: "digit", key: nextKey("int"), digit: atom.digit };
		} else if (atom.kind === "group") {
			parts[i] = { type: "symbol", key: nextKey("group"), value: atom.value };
		}
	}
	for (let i = 0; i < atoms.length; i++) {
		const atom = atoms[i];
		if (!atom) {
			continue;
		}
		if (atom.kind === "fraction") {
			parts[i] = {
				type: "digit",
				key: nextKey("fraction"),
				digit: atom.digit,
			};
		} else if (atom.kind === "symbol") {
			parts[i] = {
				type: "symbol",
				key: `${nextKey(atom.type)}:${atom.value}`,
				value: atom.value,
			};
		}
	}
	return parts;
}

function getNumberRollShift(dir: number): string {
	if (dir === 0) {
		return "0%";
	}
	return dir > 0 ? "35%" : "-35%";
}

function getNumberRollDir(
	trend: "auto" | "up" | "down",
	value: number,
	previousValue: number
): number {
	if (trend === "up") {
		return 1;
	}
	if (trend === "down") {
		return -1;
	}
	return Math.sign(value - previousValue);
}

function mergeParts(prev: RenderedPart[], next: Part[]): RenderedPart[] {
	const nextKeys = new Set(next.map((part) => part.key));
	const prevKeys = new Set(prev.map((part) => part.key));
	const out: RenderedPart[] = [];
	let i = 0;
	const emitExited = (until: string | undefined) => {
		while (i < prev.length && prev[i]?.key !== until) {
			const old = prev[i];
			i += 1;
			if (old && !nextKeys.has(old.key)) {
				out.push(old.exiting ? old : { ...old, exiting: true });
			}
		}
	};
	for (const part of next) {
		if (prevKeys.has(part.key)) {
			emitExited(part.key);
			i += 1;
			out.push(part);
		} else {
			out.push({ ...part, entered: true });
		}
	}
	emitExited(undefined);
	return out;
}

function rollDelta(from: number, to: number, dir: number): number {
	const up = (((to - from) % 10) + 10) % 10;
	if (dir > 0) {
		return up;
	}
	if (dir < 0) {
		return up - 10;
	}
	return up > 5 ? up - 10 : up;
}

function NumberRollDigit({ digit, dir }: { digit: number; dir: number }) {
	const [state, setState] = useState({ digit, roll: digit });
	if (state.digit !== digit) {
		setState({ digit, roll: state.roll + rollDelta(state.digit, digit, dir) });
	}
	return (
		<span
			className="relative inline-block overflow-clip duration-(--ryu-number-roll-duration) ease-(--ryu-number-roll-ease) [transition-property:--ryu-number-roll-pos] motion-reduce:transition-none"
			data-slot="number-roll-digit"
			style={{ "--ryu-number-roll-pos": state.roll } as CSSProperties}
		>
			<span
				className="invisible before:content-[attr(data-d)]"
				data-d={digit}
			/>
			{DIGIT_CELLS.map((cell) => (
				<span
					className="absolute inset-0 text-center before:content-[attr(data-d)]"
					data-d={cell}
					key={cell}
					style={{
						transform: `translateY(clamp(-1lh, calc((mod(mod(${cell} - var(--ryu-number-roll-pos), 10) + 5, 10) - 5) * 1lh), 1lh))`,
					}}
				/>
			))}
		</span>
	);
}

function NumberRollPart({ part, dir }: { part: RenderedPart; dir: number }) {
	return (
		<span
			className={cn(
				"inline-grid grid-cols-[1fr] transition-[grid-template-columns,opacity,translate] duration-(--ryu-number-roll-fade) ease-out motion-reduce:transition-none",
				part.entered &&
					"starting:translate-y-(--ryu-number-roll-shift) starting:grid-cols-[0fr] starting:opacity-0",
				part.exiting &&
					"pointer-events-none translate-y-[calc(var(--ryu-number-roll-shift)*-1)] grid-cols-[0fr] opacity-0"
			)}
			data-slot="number-roll-part"
			style={
				{
					"--ryu-number-roll-shift": getNumberRollShift(dir),
				} as CSSProperties
			}
		>
			<span className="min-w-0 overflow-hidden">
				{part.type === "digit" ? (
					<NumberRollDigit digit={part.digit} dir={dir} />
				) : (
					<span className="whitespace-pre" data-slot="number-roll-symbol">
						{part.value}
					</span>
				)}
			</span>
		</span>
	);
}

export type NumberRollProps = Omit<
	ComponentProps<"span">,
	"children" | "prefix"
> & {
	value: number;
	format?: Intl.NumberFormatOptions;
	locales?: Intl.LocalesArgument;
	prefix?: string;
	suffix?: string;
	trend?: "auto" | "up" | "down";
	duration?: number;
};

export function NumberRoll({
	value,
	format,
	locales,
	prefix,
	suffix,
	trend = "auto",
	duration = DEFAULT_DURATION_MS,
	className,
	style,
	...props
}: NumberRollProps) {
	const [enhanced, setEnhanced] = useState(false);
	useEffect(() => {
		if (canAnimate()) {
			setEnhanced(true);
		}
	}, []);

	const formatter = getFormatter(locales, format);
	const parts = useMemo(
		() => toParts(value, formatter, prefix, suffix),
		[value, formatter, prefix, suffix]
	);
	const formatted = `${prefix ?? ""}${formatter.format(value)}${suffix ?? ""}`;
	const [display, setDisplay] = useState<{
		value: number;
		formatted: string;
		rendered: RenderedPart[];
		dir: number;
	}>(() => ({ value, formatted, rendered: parts, dir: 0 }));

	if (display.formatted !== formatted) {
		setDisplay({
			value,
			formatted,
			rendered: mergeParts(display.rendered, parts),
			dir: getNumberRollDir(trend, value, display.value),
		});
	}

	const exitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const lastDuration = useRef(duration);
	useEffect(() => {
		const timers = exitTimers.current;
		if (lastDuration.current !== duration) {
			lastDuration.current = duration;
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
		}
		const exiting = new Set(
			display.rendered.filter((part) => part.exiting).map((part) => part.key)
		);
		for (const [key, timer] of timers) {
			if (!exiting.has(key)) {
				clearTimeout(timer);
				timers.delete(key);
			}
		}
		for (const key of exiting) {
			if (timers.has(key)) {
				continue;
			}
			timers.set(
				key,
				setTimeout(() => {
					timers.delete(key);
					setDisplay((current) => ({
						...current,
						rendered: current.rendered.filter(
							(part) => !(part.exiting && part.key === key)
						),
					}));
				}, duration)
			);
		}
	}, [display.rendered, duration]);

	useEffect(() => {
		const timers = exitTimers.current;
		return () => {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
		};
	}, []);

	return (
		<span
			className={cn("inline-block whitespace-nowrap tabular-nums", className)}
			data-slot="number-roll"
			style={
				{
					"--ryu-number-roll-duration": `${duration}ms`,
					"--ryu-number-roll-fade":
						"calc(var(--ryu-number-roll-duration) * 0.6)",
					"--ryu-number-roll-ease": "cubic-bezier(0.23, 1, 0.32, 1)",
					...style,
				} as CSSProperties
			}
			{...props}
		>
			<span className="sr-only">{formatted}</span>
			{enhanced ? (
				<span aria-hidden className="inline-block select-none">
					{display.rendered.map((part) => (
						<NumberRollPart dir={display.dir} key={part.key} part={part} />
					))}
				</span>
			) : (
				<span aria-hidden>{formatted}</span>
			)}
		</span>
	);
}
