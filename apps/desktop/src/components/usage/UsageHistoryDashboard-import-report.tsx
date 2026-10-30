"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { SettingsCard } from "@/src/components/settings/shared/settings-items.tsx";
import type { HistoryImportReport } from "@/src/lib/api/usage-history.ts";

export function ImportReportCard({
	importReport,
	importing,
}: {
	importReport: HistoryImportReport;
	importing: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsCard className="text-xs">
			<div role="status">
				{importing ? (
					<p className="mb-1 text-muted-foreground">
						Import running on this node. Progress refreshes automatically.
					</p>
				) : null}
				<p>
					{tl(
						"{imported} new records · {updated} updated · {unchanged} unchanged · {scanned} items scanned",
						{
							imported: formatNumber(importReport.importedRecords),
							scanned: formatNumber(importReport.scannedFiles),
							unchanged: formatNumber(importReport.duplicateRecords),
							updated: formatNumber(importReport.updatedRecords),
						}
					)}
				</p>
				{importReport.hasMore ? (
					<p className="mt-1 text-muted-foreground">
						More files remain. Continue import to resume.
					</p>
				) : null}
				{importReport.errorCount ? (
					<p className="mt-1 text-destructive">
						{tl("{count} files could not be read. {errors}", {
							count: formatNumber(importReport.errorCount),
							errors: importReport.errors.slice(0, 2).join(" "),
						})}
					</p>
				) : null}
			</div>
		</SettingsCard>
	);
}
