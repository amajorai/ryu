/** Preserve the complete native fetch property owner while dispatching fixture calls. */
export function createFetchFixture(
	target: typeof globalThis.fetch,
	callback: (
		...args: Parameters<typeof globalThis.fetch>
	) => ReturnType<typeof globalThis.fetch>
): typeof globalThis.fetch {
	return new Proxy(target, {
		apply(_target, _receiver, argumentsList) {
			return callback(argumentsList[0], argumentsList[1]);
		},
	});
}
