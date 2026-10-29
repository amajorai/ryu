/** The Island renderer can request microphone audio, never camera or display capture. */
export function allowsMicrophoneRequest(
	isIslandWindow: boolean,
	permission: string,
	isMainFrame: boolean,
	mediaTypes: readonly string[] | undefined
): boolean {
	return (
		isIslandWindow &&
		isMainFrame &&
		permission === "media" &&
		mediaTypes?.length === 1 &&
		mediaTypes[0] === "audio"
	);
}

export function allowsMicrophoneCheck(
	isIslandWindow: boolean,
	permission: string,
	isMainFrame: boolean,
	mediaType: string | undefined
): boolean {
	return (
		isIslandWindow &&
		isMainFrame &&
		permission === "media" &&
		mediaType === "audio"
	);
}
