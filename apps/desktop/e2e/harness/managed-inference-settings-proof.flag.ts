export function useFeatureFlag(key: string): boolean {
	return (
		key === "ui.managed_inference_card" &&
		window.__managedInferenceProof.flagEnabled
	);
}
