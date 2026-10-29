"use client";

import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import { Button, buttonVariants } from "@ryu/ui/components/button.tsx";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { displayWallClock, useDisplayLocale } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ComponentProps, useEffect, useMemo, useRef } from "react";
import {
	type DayButton,
	DayPicker,
	type Formatters,
	getDefaultClassNames,
	type Labels,
	type Locale,
	type Modifiers,
} from "react-day-picker";
import { z } from "zod";

export interface CalendarLocalization {
	formatters: Partial<Formatters>;
	labels: Partial<Labels>;
	locale?: Partial<Locale>;
}

/** The words a calendar shows besides dates, which a language pack translates. */
export interface CalendarWords {
	chooseMonth: string;
	chooseYear: string;
	navigation: string;
	nextMonth: string;
	previousMonth: string;
	selected: string;
	today: string;
}

/**
 * DayPicker's own English labels. They double as the literal ids language
 * packs translate, so an English calendar reads exactly as DayPicker's does.
 */
const ENGLISH_CALENDAR_WORDS: CalendarWords = {
	chooseMonth: "Choose the Month",
	chooseYear: "Choose the Year",
	navigation: "Navigation bar",
	nextMonth: "Go to the Next Month",
	previousMonth: "Go to the Previous Month",
	selected: "selected",
	today: "Today",
};

/** DayPicker's week starts, indexed by Intl's `firstDay` modulo 7 (7 = Sunday). */
const WEEK_STARTS = [0, 1, 2, 3, 4, 5, 6] as const;

const weekInfoSchema = z.object({ firstDay: z.number().int().min(1).max(7) });

function supportedLocale(code: string | undefined): string | undefined {
	if (!code) {
		return;
	}
	try {
		return Intl.DateTimeFormat.supportedLocalesOf(code).length > 0
			? code
			: undefined;
	} catch {
		return;
	}
}

/**
 * The locale's first day of the week from Intl week data: `getWeekInfo()` in
 * current engines, the `weekInfo` getter in older ones. An engine with neither
 * (or with malformed data) yields `undefined`, which keeps DayPicker's Sunday.
 */
function localeWeekStart(
	locale: string
): (typeof WEEK_STARTS)[number] | undefined {
	let weekInfo: unknown;
	try {
		const intlLocale = new Intl.Locale(locale);
		const getWeekInfo: unknown = Reflect.get(intlLocale, "getWeekInfo");
		weekInfo =
			typeof getWeekInfo === "function"
				? Reflect.apply(getWeekInfo, intlLocale, [])
				: Reflect.get(intlLocale, "weekInfo");
	} catch {
		return;
	}
	const parsed = weekInfoSchema.safeParse(weekInfo);
	return parsed.success ? WEEK_STARTS[parsed.data.firstDay % 7] : undefined;
}

/**
 * Intl-backed DayPicker text for a BCP 47 display locale. DayPicker's own
 * labels come from its bundled English date-fns locale, so without this the
 * day names, captions, accessible day labels and navigation names stay
 * English, and weeks start on Sunday, while the surrounding cell follows the
 * display language. Dates are civil (local midnight), so no time zone is
 * applied.
 */
export function calendarLocalization(
	code: string | undefined,
	translatedWords: Partial<CalendarWords> = {}
): CalendarLocalization {
	const words = { ...ENGLISH_CALENDAR_WORDS, ...translatedWords };
	const locale = supportedLocale(code);
	const weekStartsOn = locale ? localeWeekStart(locale) : undefined;
	const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
	const monthYear = new Intl.DateTimeFormat(locale, {
		month: "long",
		year: "numeric",
	});
	const shortWeekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
	const longWeekday = new Intl.DateTimeFormat(locale, { weekday: "long" });
	const dayLabel = (date: Date, modifiers?: Modifiers) => {
		const label = fullDate.format(date);
		return modifiers?.today ? `${words.today}, ${label}` : label;
	};
	let calendarLocale: Partial<Locale> | undefined;
	if (locale) {
		// DayPicker merges this over its English locale, whose options start the
		// week on Sunday, so the display locale's own start is carried here.
		calendarLocale =
			weekStartsOn === undefined
				? { code: locale }
				: { code: locale, options: { weekStartsOn } };
	}
	return {
		locale: calendarLocale,
		formatters: {
			formatCaption: (month) => monthYear.format(month),
			formatWeekdayName: (weekday) => shortWeekday.format(weekday),
		},
		labels: {
			labelDayButton: (date, modifiers) => {
				const label = dayLabel(date, modifiers);
				return modifiers.selected ? `${label}, ${words.selected}` : label;
			},
			labelGrid: (month) => monthYear.format(month),
			labelGridcell: dayLabel,
			labelMonthDropdown: () => words.chooseMonth,
			labelNav: () => words.navigation,
			labelNext: () => words.nextMonth,
			labelPrevious: () => words.previousMonth,
			labelWeekday: (weekday) => longWeekday.format(weekday),
			labelYearDropdown: () => words.chooseYear,
		},
	};
}

/** {@link calendarLocalization} with its words taken from the active language pack. */
export function useCalendarLocalization(
	code: string | undefined
): CalendarLocalization {
	const english = ENGLISH_CALENDAR_WORDS;
	const chooseMonth =
		useLocalizedString(english.chooseMonth) ?? english.chooseMonth;
	const chooseYear =
		useLocalizedString(english.chooseYear) ?? english.chooseYear;
	const navigation =
		useLocalizedString(english.navigation) ?? english.navigation;
	const nextMonth = useLocalizedString(english.nextMonth) ?? english.nextMonth;
	const previousMonth =
		useLocalizedString(english.previousMonth) ?? english.previousMonth;
	const selected = useLocalizedString(english.selected) ?? english.selected;
	const today = useLocalizedString(english.today) ?? english.today;
	return useMemo(
		() =>
			calendarLocalization(code, {
				chooseMonth,
				chooseYear,
				navigation,
				nextMonth,
				previousMonth,
				selected,
				today,
			}),
		[
			chooseMonth,
			chooseYear,
			code,
			navigation,
			nextMonth,
			previousMonth,
			selected,
			today,
		]
	);
}

/** What a calendar's caller passed for its text; any of it may be absent. */
export type CalendarTextProps = Partial<CalendarLocalization>;

/**
 * The text a calendar renders: the caller's own, with the display language as
 * the default. With a display language chosen, a calendar speaks it unless the
 * caller names a locale of its own (that caller owns the language, so nothing
 * of the display language is mixed in). Labels and formatters a caller passes
 * still win key by key. With no display language DayPicker's English stays.
 * Every calendar in the product, the Plate date node's included, reads it here
 * so the default cannot drift between copies.
 */
export function useDisplayCalendarText(
	props: CalendarTextProps
): CalendarTextProps {
	const displayLocale = useDisplayLocale();
	const displayText = useCalendarLocalization(displayLocale);
	if (displayLocale === undefined || props.locale !== undefined) {
		return props;
	}
	return {
		formatters: { ...displayText.formatters, ...props.formatters },
		labels: { ...displayText.labels, ...props.labels },
		locale: displayText.locale,
	};
}

/**
 * Today in the display time zone, as the civil (local-midnight) date a
 * calendar's own days are. DayPicker's default is the computer's date, which
 * is another day for part of every day when the two zones differ. The date
 * moves at the display zone's midnight and when the zone changes; left on the
 * system zone it is the computer's date, as DayPicker's own. Every calendar in
 * the product reads it here, the Plate date node's included.
 */
export function useDisplayToday(): Date {
	// Subscribing re-renders at the display zone's midnight and on a zone change.
	useDisplayDayRevision();
	const { day, month, year } = displayWallClock(Date.now());
	return useMemo(() => new Date(year, month - 1, day), [day, month, year]);
}

function Calendar({
	className,
	appearance = "default",
	classNames,
	showOutsideDays = true,
	captionLayout = "label",
	buttonVariant = "ghost",
	locale: localeProp,
	labels: labelsProp,
	formatters: formattersProp,
	components,
	...props
}: ComponentProps<typeof DayPicker> & {
	buttonVariant?: ComponentProps<typeof Button>["variant"];
	appearance?: "default" | "bordered";
}) {
	const defaultClassNames = getDefaultClassNames();
	const { formatters, labels, locale } = useDisplayCalendarText({
		formatters: formattersProp,
		labels: labelsProp,
		locale: localeProp,
	});

	const displayToday = useDisplayToday();

	return (
		<DayPicker
			captionLayout={captionLayout}
			className={cn(
				"group/calendar bg-background in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent p-3 [--cell-radius:var(--radius-4xl)] [--cell-size:--spacing(8)]",
				String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
				String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
				appearance === "bordered" && "rounded-2xl border border-border",
				className
			)}
			classNames={{
				root: cn("w-fit", defaultClassNames.root),
				months: cn(
					"relative flex flex-col gap-4 md:flex-row",
					defaultClassNames.months
				),
				month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
				nav: cn(
					"absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
					defaultClassNames.nav
				),
				button_previous: cn(
					buttonVariants({ variant: buttonVariant }),
					"corner-round size-(--cell-size) select-none p-0 aria-disabled:opacity-50",
					defaultClassNames.button_previous
				),
				button_next: cn(
					buttonVariants({ variant: buttonVariant }),
					"corner-round size-(--cell-size) select-none p-0 aria-disabled:opacity-50",
					defaultClassNames.button_next
				),
				month_caption: cn(
					"flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
					defaultClassNames.month_caption
				),
				dropdowns: cn(
					"flex h-(--cell-size) w-full items-center justify-center gap-1.5 font-medium text-sm",
					defaultClassNames.dropdowns
				),
				dropdown_root: cn(
					"relative rounded-(--cell-radius)",
					defaultClassNames.dropdown_root
				),
				dropdown: cn(
					"absolute inset-0 bg-popover opacity-0",
					defaultClassNames.dropdown
				),
				caption_label: cn(
					"select-none font-medium",
					captionLayout === "label"
						? "text-sm"
						: "flex items-center gap-1 rounded-(--cell-radius) text-sm [&>svg]:size-3.5 [&>svg]:text-muted-foreground",
					defaultClassNames.caption_label
				),
				weekdays: cn("flex", defaultClassNames.weekdays),
				weekday: cn(
					"flex-1 select-none rounded-(--cell-radius) font-normal text-[0.8rem] text-muted-foreground",
					defaultClassNames.weekday
				),
				week: cn("mt-2 flex w-full", defaultClassNames.week),
				week_number_header: cn(
					"w-(--cell-size) select-none",
					defaultClassNames.week_number_header
				),
				week_number: cn(
					"select-none text-[0.8rem] text-muted-foreground",
					defaultClassNames.week_number
				),
				day: cn(
					"group/day relative aspect-square h-full w-full select-none rounded-(--cell-radius) p-0 text-center [&:last-child[data-selected=true]_button]:rounded-e-(--cell-radius)",
					props.showWeekNumber
						? "[&:nth-child(2)[data-selected=true]_button]:rounded-s-(--cell-radius)"
						: "[&:first-child[data-selected=true]_button]:rounded-s-(--cell-radius)",
					defaultClassNames.day
				),
				range_start: cn(
					"relative isolate z-0 rounded-s-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:end-0 after:w-4 after:bg-muted",
					defaultClassNames.range_start
				),
				range_middle: cn("rounded-none", defaultClassNames.range_middle),
				range_end: cn(
					"relative isolate z-0 rounded-e-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:start-0 after:w-4 after:bg-muted",
					defaultClassNames.range_end
				),
				today: cn(
					"rounded-(--cell-radius) bg-muted text-foreground data-[selected=true]:rounded-none",
					defaultClassNames.today
				),
				outside: cn(
					"text-muted-foreground aria-selected:text-muted-foreground",
					defaultClassNames.outside
				),
				disabled: cn(
					"text-muted-foreground opacity-50",
					defaultClassNames.disabled
				),
				hidden: cn("invisible", defaultClassNames.hidden),
				...classNames,
			}}
			components={{
				Root: ({ className, rootRef, ...props }) => {
					return (
						<div
							className={cn(className)}
							data-slot="calendar"
							ref={rootRef}
							{...props}
						/>
					);
				},
				Chevron: ({ className, orientation, ...props }) => {
					if (orientation === "left") {
						return (
							<HugeiconsIcon
								className={cn("size-4", className)}
								icon={ArrowLeftIcon}
								strokeWidth={2}
								{...props}
							/>
						);
					}

					if (orientation === "right") {
						return (
							<HugeiconsIcon
								className={cn("size-4", className)}
								icon={ArrowRightIcon}
								strokeWidth={2}
								{...props}
							/>
						);
					}

					return (
						<HugeiconsIcon
							className={cn("size-4", className)}
							icon={ArrowDownIcon}
							strokeWidth={2}
							{...props}
						/>
					);
				},
				DayButton: ({ ...props }) => (
					<CalendarDayButton locale={locale} {...props} />
				),
				WeekNumber: ({ children, ...props }) => {
					return (
						<td {...props}>
							<div className="flex size-(--cell-size) items-center justify-center text-center">
								{children}
							</div>
						</td>
					);
				},
				...components,
			}}
			formatters={{
				formatMonthDropdown: (date) =>
					date.toLocaleString(locale?.code, { month: "short" }),
				...formatters,
			}}
			labels={labels}
			locale={locale}
			showOutsideDays={showOutsideDays}
			// A caller's `timeZone` makes DayPicker own today in that zone, and a
			// caller's own `today` (spread below) wins.
			today={props.timeZone ? undefined : displayToday}
			{...props}
		/>
	);
}

function CalendarDayButton({
	className,
	day,
	modifiers,
	locale,
	...props
}: ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }) {
	const defaultClassNames = getDefaultClassNames();

	const ref = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (modifiers.focused) {
			ref.current?.focus();
		}
	}, [modifiers.focused]);

	return (
		<Button
			className={cn(
				"relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 border-0 font-normal leading-none data-[range-end=true]:rounded-(--cell-radius) data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-s-(--cell-radius) data-[range-end=true]:rounded-e-(--cell-radius) data-[range-end=true]:bg-primary data-[range-middle=true]:bg-muted data-[range-start=true]:bg-primary data-[selected-single=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:text-foreground data-[range-start=true]:text-primary-foreground data-[selected-single=true]:text-primary-foreground group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-3 group-data-[focused=true]/day:ring-ring dark:hover:text-foreground [&>span]:text-xs [&>span]:opacity-70",
				defaultClassNames.day,
				className
			)}
			data-day={day.date.toLocaleDateString(locale?.code)}
			data-range-end={modifiers.range_end}
			data-range-middle={modifiers.range_middle}
			data-range-start={modifiers.range_start}
			data-selected-single={
				modifiers.selected &&
				!modifiers.range_start &&
				!modifiers.range_end &&
				!modifiers.range_middle
			}
			// DayPicker moves keyboard focus through the `focused` modifier; the
			// effect above can only honor it when the ref reaches the DOM button.
			ref={ref}
			size="icon"
			variant="ghost"
			{...props}
		/>
	);
}

export { Calendar, CalendarDayButton };
