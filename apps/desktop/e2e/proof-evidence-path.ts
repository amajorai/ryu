import path from "node:path";

// Where a proof spec or harness writes evidence (screenshots, JSON ledgers,
// Playwright output) it would otherwise commit under the repository's
// docs/proof tree. RYU_PROOF_EVIDENCE_DIR redirects it (keeping the path below
// docs/proof) so a revalidation run leaves tracked evidence untouched; without
// it the committed evidence is refreshed. Every desktop e2e path under
// docs/proof goes through here: tools/desktop-e2e-proof-evidence.test.mjs
// fails on a hard-coded one.
export function proofEvidencePath(...segments: string[]): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, ...segments)
		: path.resolve(import.meta.dirname, "../../../docs/proof", ...segments);
}

// The few older proofs that commit under apps/docs/proof instead. Redirected
// below an `apps-docs` folder of RYU_PROOF_EVIDENCE_DIR so the two trees never
// collide.
export function appsDocsProofEvidencePath(...segments: string[]): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, "apps-docs", ...segments)
		: path.resolve(import.meta.dirname, "../../docs/proof", ...segments);
}
