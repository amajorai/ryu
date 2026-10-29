import { describe, expect, test } from "bun:test";
import {
	MARKETPLACE_PUBLISH_PACKAGE_KINDS,
	runMarketplacePublishPreflight,
} from "./publish-preflight.ts";

const baseInput = {
	declaredArtifactCount: 1,
	kindArtifactsValid: true,
	immutableSourceVerified: true,
	packageSecurityPassed: true,
	gatewayGrantsApproved: true,
	uiDetected: false,
	uiSurface: "none" as const,
};

describe("Marketplace publish preflight", () => {
	for (const packageKind of MARKETPLACE_PUBLISH_PACKAGE_KINDS) {
		test(`assigns a package grade without requiring UI for ${packageKind}`, () => {
			const report = runMarketplacePublishPreflight({
				...baseInput,
				packageKind,
				presentArtifactCount: 1,
			});

			expect(report.grade).toBe("A");
			expect(report.score).toBe(100);
			expect(report.passed).toBe(true);
			expect(report.uiDetected).toBe(false);
			expect(report.uiGrade).toBeNull();
			expect(
				report.checks.find((check) => check.id === "ui-applicability")?.status
			).toBe("pass");
		});
	}

	test("blocks a package with missing artifacts, unapproved grants, or bad integrity", () => {
		const report = runMarketplacePublishPreflight({
			...baseInput,
			packageKind: "workflow",
			presentArtifactCount: 0,
			gatewayGrantsApproved: false,
			immutableSourceVerified: false,
		});

		expect(report.grade).not.toBe("A");
		expect(report.passed).toBe(false);
		expect(
			report.checks.filter((check) => check.status === "fail")
		).toHaveLength(3);
	});

	test("requires complete Grade A evidence when UI is detected", () => {
		const report = runMarketplacePublishPreflight({
			...baseInput,
			packageKind: "app",
			presentArtifactCount: 1,
			uiDetected: true,
			uiSurface: "companion",
			uiEvidence: {
				navigation: "manifest",
				files: [
					{
						path: "ui/src/main.tsx",
						contents: [
							'import { markCompanionAppRoot, subscribeCompanionTheme } from "@ryu/app-host/companion-theme";',
							'import { RyuAppShell } from "@ryu/blocks/companion/app-ui";',
							'markCompanionAppRoot(document.getElementById("root"));',
							"subscribeCompanionTheme();",
							'import { Button, Empty, Spinner } from "@ryu/ui/components";',
							'<RyuAppShell className="bg-background text-foreground">',
							'<Button aria-label="Save" disabled={loading}>Save</Button>',
							"{loading ? <Spinner /> : null}",
							"{empty ? <Empty /> : null}",
							"{error ? <p>Unable to load</p> : null}",
							"</RyuAppShell>",
						].join("\n"),
					},
					{
						path: "ui/src/styles.css",
						contents: '@import "@ryu/ui/app-ui.css";',
					},
				],
			},
		});

		expect(report.uiDetected).toBe(true);
		expect(report.uiGrade).toBe("A");
		expect(report.passed).toBe(true);
	});

	test("does not pass UI-bearing packages with missing evidence", () => {
		const report = runMarketplacePublishPreflight({
			...baseInput,
			packageKind: "plugin",
			presentArtifactCount: 1,
			uiDetected: true,
		});

		expect(report.uiGrade).toBe("F");
		expect(report.grade).not.toBe("A");
		expect(report.passed).toBe(false);
		expect(
			report.checks.find((check) => check.id === "ui-evidence-complete")?.status
		).toBe("fail");
	});

	test("fails closed when a new package kind has no scorecard profile", () => {
		const report = runMarketplacePublishPreflight({
			...baseInput,
			packageKind: "future_kind",
			presentArtifactCount: 1,
		});

		expect(report.grade).not.toBe("A");
		expect(report.passed).toBe(false);
	});
});
