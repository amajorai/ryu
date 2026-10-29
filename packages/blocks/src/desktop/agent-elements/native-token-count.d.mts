import type { NativeCountConversion } from "@ryu/ui/lib/number-format.ts";

/** Complete ECMAScript operand domain, including callable objects and native throws. */
export type NativeTokenOperand =
	| number
	| string
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| NativeCountConversion;
export function addCompletionTokens(
	promptTokens: NativeTokenOperand,
	completionTokens: NativeTokenOperand
): number | string | bigint;
export function tokenCountLabel(completionTokens: NativeTokenOperand): string;
export function formatSessionCurrency(
	amount: number,
	currency: NativeTokenOperand,
	options: Intl.NumberFormatOptions
): string;

export function readGenerationSpeed(
	data: NativeTokenOperand
): NativeTokenOperand;
