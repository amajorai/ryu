import type { NativeTokenOperand } from "./native-token-count.mjs";
/** Successful native field-get result domain; no object, metadata or numeric DTO is asserted. */
export function readContextField<Receiver, Key>(
	receiver: Receiver,
	key: Key
): NativeTokenOperand;
export function sumContextTokens(
	prompt: NativeTokenOperand,
	completion: NativeTokenOperand
): number | string | bigint;
export function isPositiveContextCount(value: NativeTokenOperand): boolean;
export function isNonPositiveContextCount(value: NativeTokenOperand): boolean;
export function nativeContextPct(
	used: NativeTokenOperand,
	total: NativeTokenOperand
): number;
export function nativeContextRemaining(
	total: () => NativeTokenOperand,
	used: () => NativeTokenOperand
): number;
export function nativeContextMax(
	left: () => NativeTokenOperand,
	right: () => NativeTokenOperand
): number;
