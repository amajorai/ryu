export function useStepUp() {
	return {
		dialog: null,
		guard: async <T>(_scope: string, action: () => Promise<T>) => action(),
	};
}
