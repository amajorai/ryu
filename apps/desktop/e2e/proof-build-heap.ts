// Node heap for a proof webServer that runs a full Vite build of a large
// product graph. Node's default heap (about 2 GB on smaller hosts) runs out
// mid-build there, as patch-diff-panel-proof's config notes. The caller's own
// NODE_OPTIONS are kept; the later --max-old-space-size wins.
export function proofBuildHeapEnv(megabytes: number): { NODE_OPTIONS: string } {
	return {
		NODE_OPTIONS: [
			process.env.NODE_OPTIONS,
			`--max-old-space-size=${megabytes}`,
		]
			.filter(Boolean)
			.join(" "),
	};
}
