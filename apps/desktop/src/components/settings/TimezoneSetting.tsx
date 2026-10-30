// apps/desktop/src/components/settings/TimezoneSetting.tsx
//
// Appearance → "Date & time": the display time zone every wall-clock timestamp
// in the app is rendered in. ~450 IANA zones is far too many for a Select, so
// this is the searchable Combobox; the offset prefix is what makes the list
// scannable when you half-remember the city.
//
// The store lives in @/src/lib/timezone.ts. This component subscribes through
// `useTimezone()` so the live preview under the row repaints the instant the
// zone changes — that preview is also the user's proof the setting took.

import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxTrigger,
	ComboboxValue,
} from "@ryu/ui/components/combobox.tsx";
import { InputGroupAddon } from "@ryu/ui/components/input-group.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTimezone } from "@/src/hooks/useTimezone.ts";
import {
	effectiveTimeZone,
	formatDateTime,
	timezoneLabel,
	timezoneOptions,
} from "@/src/lib/timezone.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** The trigger has to read as one of the Selects it sits beside in this tab. */

const PREVIEW_OPTIONS: Intl.DateTimeFormatOptions = {
	weekday: "short",
	day: "numeric",
	month: "short",
	hour: "numeric",
	minute: "2-digit",
};

const PREVIEW_TICK_MS = 30_000;

export function TimezoneSetting() {
	const tl = useLiteralMessages();
	const [timezone, setTimezone] = useTimezone();
	// The preview is a clock, so it has to move on its own as well as when the
	// zone changes — otherwise it goes stale the moment the tab is left open.
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), PREVIEW_TICK_MS);
		return () => clearInterval(id);
	}, []);

	// ~450 entries that never change within a session: built once by the module
	// and only read here.
	const options = timezoneOptions();
	const values = useMemo(() => options.map((o) => o.value), [options]);
	const labels = useMemo(
		() => new Map(options.map((o) => [o.value, o.label])),
		[options]
	);

	const labelFor = useCallback(
		(value: string) => labels.get(value) ?? timezoneLabel(value),
		[labels]
	);

	// Search matches the LABEL and the raw IANA id, with `_` and space treated as
	// the same character. The label deliberately reads `America/Los Angeles` — the
	// underscore is stripped because it looks like a typo in a settings row — but
	// the default filter only sees that label, so typing the id you actually know
	// (`Los_Angeles`, the string in every config file and error message) matched
	// nothing and the list went empty. Comparing against the id as well means both
	// spellings work, and normalizing the query means `los_angeles`, `los angeles`
	// and `LosAngeles`-with-a-space all land on the same row.
	const searchFilter = useCallback(
		(value: string, query: string) => {
			const needle = query.trim().toLowerCase().replace(/_/g, " ");
			if (!needle) {
				return true;
			}
			const haystack = `${labelFor(value)} ${value}`
				.toLowerCase()
				.replace(/_/g, " ");
			return haystack.includes(needle);
		},
		[labelFor]
	);

	const handleChange = useCallback(
		(next: string | null) => {
			if (next) {
				setTimezone(next);
			}
		},
		[setTimezone]
	);

	// `timezone` is read so this component re-renders on a change; the preview
	// below is what the value is actually for.
	const preview = `${formatDateTime(now, PREVIEW_OPTIONS)} · ${effectiveTimeZone().replace(/_/g, " ")}`;

	return (
		<SettingsSection
			caption="Changes how times are shown only; nothing is rescheduled."
			title="Date & time"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Combobox
							autoHighlight
							filter={searchFilter}
							items={values}
							itemToStringLabel={labelFor}
							onValueChange={handleChange}
							value={timezone}
						>
							<ComboboxTrigger className="w-64" purpose="timezone-select">
								<ComboboxValue placeholder="Select time zone" />
							</ComboboxTrigger>
							<ComboboxContent aria-label="Select time zone">
								<div className="border-border border-b p-2">
									<ComboboxInput
										placeholder="Search a city or zone…"
										showTrigger={false}
									>
										{/* `order-first` on the addon puts this before the input
										    even though it is rendered after it. */}
										<InputGroupAddon align="inline-start">
											<HugeiconsIcon
												className="size-4 text-muted-foreground"
												icon={Search01Icon}
											/>
										</InputGroupAddon>
									</ComboboxInput>
								</div>
								<ComboboxEmpty>No time zones found.</ComboboxEmpty>
								<ComboboxList>
									{(item: string) => (
										<ComboboxItem key={item} value={item}>
											{labelFor(item)}
										</ComboboxItem>
									)}
								</ComboboxList>
							</ComboboxContent>
						</Combobox>
					}
					description={tl("Timestamps currently read {preview}.", { preview })}
					title="Time zone"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
