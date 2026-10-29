/** Fail explicitly when an expected fixture/result element is absent. */
export function requireTestValue<T>(value: T | undefined, context: string): T {
	if (value === undefined)
		throw new Error(`Missing expected test value: ${context}`);
	return value;
}
