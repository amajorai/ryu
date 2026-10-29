import { formatCurrency } from "@ryu/ui/lib/number-format.ts";

// These operations deliberately retain native operand conversion and throws.
// Persisted ACP counts can be strings or other legacy JS operands; filtering or
// coercing them at the parent would change concatenation and child-render timing.
export function addCompletionTokens(promptTokens, completionTokens) {
	return (promptTokens ?? 0) + completionTokens;
}

export function tokenCountLabel(completionTokens) {
	return `${completionTokens} tokens`;
}

// The existing formatter owns its native currency-method behavior. Retain its
// NaN/Infinity fallback and the original errors for unsupported currency values.
export function formatSessionCurrency(amount, currency, options) {
	return formatCurrency(amount, currency, options);
}

// Preserve native field-get receiver, read order and null/undefined throws before
// the generation guard checks the resulting number. Boxing changes strict
// inherited primitive getters, and rejecting null would suppress native errors.
export function readGenerationSpeed(data) {
	return data.tokensPerSecond;
}
