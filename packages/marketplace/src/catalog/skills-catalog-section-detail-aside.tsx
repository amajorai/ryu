import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingInfoGrid,
	type ListingInfoRow,
} from "./detail/listing-detail-shell.tsx";
import { safeHttpUrl } from "./safe-url.ts";
import { formatDateLabel } from "./skills-catalog-section-model.ts";
import type { SkillDetail } from "./types.ts";

/** The skill detail rail: provenance rows, then the security-audit list. The
 *  audits were previously buried under a seven-box grid at the bottom of the
 *  header — for a listing whose whole trust story IS the audit, that is the one
 *  thing that should not need scrolling to. */
export function SkillDetailAside({
	metadata,
	sourceLabel,
	url,
}: {
	metadata: SkillDetail["metadata"];
	sourceLabel: string;
	url: string;
}) {
	const rows: (ListingInfoRow | null)[] = [
		{ label: "Source", value: sourceLabel },
		metadata.repositoryUrl
			? {
					label: "Repository",
					value: <SkillLink href={metadata.repositoryUrl} label="GitHub" />,
				}
			: null,
		{ label: "Listing", value: <SkillLink href={url} label="Open" /> },
		formatDateLabel(metadata.githubCreatedAt)
			? {
					label: "Created",
					value: formatDateLabel(metadata.githubCreatedAt),
				}
			: null,
		formatDateLabel(metadata.githubUpdatedAt)
			? {
					label: "Updated",
					value: formatDateLabel(metadata.githubUpdatedAt),
				}
			: null,
	];

	return (
		<>
			<ListingAsideCard title="Information">
				<ListingInfoGrid
					rows={rows.filter((row): row is ListingInfoRow => row !== null)}
				/>
			</ListingAsideCard>
			<ListingAsideCard title="Security audits">
				<SkillAuditList audits={metadata.securityAudits} />
			</ListingAsideCard>
		</>
	);
}

/** External link in the skill rail, scheme-guarded like every other catalog href. */
function SkillLink({ href, label }: { href: string; label: string }) {
	const safe = safeHttpUrl(href);
	if (!safe) {
		return <span className="text-muted-foreground">Unavailable</span>;
	}
	return (
		<a
			className="hover:underline"
			href={safe}
			rel="noopener noreferrer"
			target="_blank"
		>
			{label}
		</a>
	);
}

/** The security-audit list, as a rail card. Extracted from the old
 *  `SkillMetadataGrid`, whose other half (a 2-column "Not reported" x7 box grid)
 *  is now the stat strip + the Information rows: a fact the source did report is
 *  a headline cell, a fact it did not is a rail row, and neither is a box of the
 *  word "Not reported". */
function SkillAuditList({
	audits,
}: {
	audits: SkillDetail["metadata"]["securityAudits"];
}) {
	const tl = useLiteralMessages();
	if (audits.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">
				Nobody has published an audit of this skill.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			{audits.map((audit) => {
				const href = safeHttpUrl(audit.url);
				const body = (
					<>
						<div className="flex items-center justify-between gap-2">
							<span className="font-medium">{audit.name}</span>
							<span
								className={
									audit.status.toLowerCase() === "pass"
										? "font-mono text-status-success uppercase"
										: "font-mono text-status-warning uppercase"
								}
							>
								{audit.status}
							</span>
						</div>
						{audit.risk_level ? (
							<div className="mt-1 text-muted-foreground">
								{tl("Risk: {risk_level}", { risk_level: audit.risk_level })}
							</div>
						) : null}
						{audit.summary ? (
							<div className="mt-1 line-clamp-2 text-muted-foreground">
								{audit.summary}
							</div>
						) : null}
					</>
				);
				const className =
					"block w-full rounded-lg border border-border px-3 py-2 text-xs";
				return href ? (
					<a
						className={`${className} transition-colors hover:bg-accent/50`}
						href={href}
						key={audit.name}
						rel="noopener noreferrer"
						target="_blank"
					>
						{body}
					</a>
				) : (
					<div className={className} key={audit.name}>
						{body}
					</div>
				);
			})}
		</div>
	);
}
