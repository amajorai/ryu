/** Electron's system Acrylic backdrop starts with Windows 11 22H2 (build 22621). */
export function supportsBuiltInAcrylic(osRelease: string): boolean {
	const build = Number.parseInt(osRelease.split(".")[2] ?? "", 10);
	return Number.isInteger(build) && build >= 22_621;
}
