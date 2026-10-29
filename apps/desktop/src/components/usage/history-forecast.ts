import {
	forecastUsageSeries,
	type UsageForecast,
} from "@ryu/blocks/desktop/usage-forecast.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORY_FORECAST_DAYS = 14;

export interface DailyForecast {
	/** Last completed UTC date in the fit; the dashed line starts here. */
	bridgeDate: string;
	bridgeValue: number;
	/** Forecast UTC dates, starting with the in-progress `today`. */
	dates: string[];
	forecast: UsageForecast;
}

function utcDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Forecast daily values keyed by UTC date. Days without records count as zero
 * usage, and `today` is projected rather than fitted because it is partial.
 */
export function forecastDailyValues(
	values: ReadonlyMap<string, number>,
	today: string,
	horizon = HISTORY_FORECAST_DAYS
): DailyForecast | null {
	const end = Date.parse(`${today}T00:00:00.000Z`);
	const first = [...values.keys()].filter((date) => date < today).sort()[0];
	if (!(first && Number.isFinite(end))) {
		return null;
	}
	const series: number[] = [];
	for (
		let day = Date.parse(`${first}T00:00:00.000Z`);
		day < end;
		day += DAY_MS
	) {
		series.push(values.get(utcDate(day)) ?? 0);
	}
	const forecast = forecastUsageSeries(series, horizon);
	if (!forecast) {
		return null;
	}
	const bridgeDate = utcDate(end - DAY_MS);
	return {
		bridgeDate,
		bridgeValue: values.get(bridgeDate) ?? 0,
		dates: forecast.points.map((_, index) => utcDate(end + index * DAY_MS)),
		forecast,
	};
}
