import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	BOX_BILLING_ROUNDING_SECONDS,
	BOX_INCLUDED_STORAGE_GIB,
	BOX_MINIMUM_SECONDS_PER_START,
	BOX_SIZE_MICRO_USD_PER_HOUR,
	BOX_SIZES,
	BOX_STORAGE_MICRO_USD_PER_GIB_MONTH,
	boxBillableSeconds,
	boxIncludedStorageGib,
	chargeableAfterFreeAllowance,
	PLAN_IDS,
	SERVICE_BILLING_MONTH_SECONDS,
	SERVICE_RATES,
	serviceChargeMicroUsd,
} from "./plans.ts";

const MICRO_USD_PER_USD = 1_000_000;
const HOUR_SECONDS = 3600;

/** USD for `units` of a meter, before free allowances. */
const usdFor = (
	rate: { microUsd: number; perUnits: number },
	units: number
): number => (rate.microUsd * units) / rate.perUnits / MICRO_USD_PER_USD;

describe("SERVICE_RATES matches the decided price table", () => {
	it("prices Box per size at the signed-off rates", () => {
		const { meters } = SERVICE_RATES.box;
		expect(usdFor(meters.boxSmallSeconds, HOUR_SECONDS)).toBe(0.025);
		expect(usdFor(meters.boxDefaultSeconds, HOUR_SECONDS)).toBe(0.04);
		expect(usdFor(meters.boxLargeSeconds, HOUR_SECONDS)).toBe(0.07);
		// Saved state and snapshots: $0.05 per GiB-month, GiB = 2^30.
		for (const meter of [
			meters.boxStateByteSeconds,
			meters.snapshotByteSeconds,
		]) {
			expect(usdFor(meter, 2 ** 30 * SERVICE_BILLING_MONTH_SECONDS)).toBe(0.05);
		}
		expect(SERVICE_BILLING_MONTH_SECONDS).toBe(2_592_000);
		expect(Object.keys(meters).toSorted()).toEqual([
			"boxDefaultSeconds",
			"boxLargeSeconds",
			"boxSmallSeconds",
			"boxStateByteSeconds",
			"snapshotByteSeconds",
		]);
		for (const meter of Object.values(meters)) {
			expect(meter.freePerMonth).toBe(0);
		}
	});

	it("prices Notify, Passport, and Mail overage with their free allowances", () => {
		const { events } = SERVICE_RATES.notify.meters;
		expect(usdFor(events, 1000)).toBe(0.1);
		expect(events.freePerMonth).toBe(10_000);

		const { connectionSeconds, fetches } = SERVICE_RATES.passport.meters;
		expect(usdFor(connectionSeconds, SERVICE_BILLING_MONTH_SECONDS)).toBe(0.1);
		expect(connectionSeconds.freePerMonth / SERVICE_BILLING_MONTH_SECONDS).toBe(
			5
		);
		expect(usdFor(fetches, 1000)).toBe(0.1);
		expect(fetches.freePerMonth).toBe(10_000);

		const { overageRecipients } = SERVICE_RATES.mail.meters;
		expect(usdFor(overageRecipients, 1000)).toBe(1);
		expect(overageRecipients.freePerMonth).toBe(0);
	});

	it("prices Connect native toolkit calls at 400 micro-USD each", () => {
		const { nativeCalls } = SERVICE_RATES.connect.meters;
		expect(nativeCalls.microUsd / nativeCalls.perUnits).toBe(400);
		expect(usdFor(nativeCalls, 1000)).toBe(0.4);
		expect(nativeCalls.freePerMonth).toBe(0);
	});

	it("keeps every rate an integer fraction", () => {
		for (const service of Object.values(SERVICE_RATES)) {
			for (const meter of Object.values(service.meters)) {
				expect(Number.isSafeInteger(meter.microUsd)).toBe(true);
				expect(Number.isSafeInteger(meter.perUnits)).toBe(true);
				expect(Number.isSafeInteger(meter.freePerMonth)).toBe(true);
			}
		}
	});
});

describe("serviceChargeMicroUsd", () => {
	const { meters } = SERVICE_RATES.box;

	it("sums exactly and rounds up once per charge", () => {
		// One Box of each size for a full hour.
		expect(
			serviceChargeMicroUsd([
				{ quantity: HOUR_SECONDS, rate: meters.boxSmallSeconds },
				{ quantity: HOUR_SECONDS, rate: meters.boxDefaultSeconds },
				{ quantity: HOUR_SECONDS, rate: meters.boxLargeSeconds },
			])
		).toBe(25_000 + 40_000 + 70_000);
		// One small Box's 5-minute minimum is 2,083.33… micro-USD.
		expect(
			serviceChargeMicroUsd([
				{
					quantity: BOX_MINIMUM_SECONDS_PER_START,
					rate: meters.boxSmallSeconds,
				},
			])
		).toBe(2084);
		// Two thirds of a micro-USD in each of three lines is two micro-USD in
		// total, not three rounded-up lines.
		const third = { microUsd: 2, perUnits: 3 };
		expect(
			serviceChargeMicroUsd([
				{ quantity: 1, rate: third },
				{ quantity: 1, rate: third },
				{ quantity: 1, rate: third },
			])
		).toBe(2);
	});

	it("charges nothing for nothing and rejects fractional quantities", () => {
		expect(serviceChargeMicroUsd([])).toBe(0);
		expect(
			serviceChargeMicroUsd([{ quantity: 0, rate: meters.boxDefaultSeconds }])
		).toBe(0);
		expect(() =>
			serviceChargeMicroUsd([{ quantity: 1.5, rate: meters.boxDefaultSeconds }])
		).toThrow("non-negative integers");
		expect(() =>
			serviceChargeMicroUsd([{ quantity: -1, rate: meters.boxDefaultSeconds }])
		).toThrow("non-negative integers");
	});

	it("prices state and snapshot bytes exactly, with one round-up for the window", () => {
		const { boxStateByteSeconds, snapshotByteSeconds } =
			SERVICE_RATES.box.meters;
		// 1 GiB of state for an hour costs the same as 1 GiB of snapshot.
		expect(
			serviceChargeMicroUsd([
				{ quantity: 2 ** 30 * HOUR_SECONDS, rate: boxStateByteSeconds },
			])
		).toBe(
			serviceChargeMicroUsd([
				{ quantity: 2 ** 30 * HOUR_SECONDS, rate: snapshotByteSeconds },
			])
		);
		// Three 1.5 GiB snapshots for 30 days: 4.5 GiB-months = $0.225,
		// summed exactly rather than rounded per snapshot.
		const line = {
			quantity: 1.5 * 2 ** 30 * SERVICE_BILLING_MONTH_SECONDS,
			rate: snapshotByteSeconds,
		};
		expect(serviceChargeMicroUsd([line, line, line])).toBe(225_000);
	});

	it("prices Mail overage per recipient", () => {
		const { overageRecipients } = SERVICE_RATES.mail.meters;
		expect(
			serviceChargeMicroUsd([{ quantity: 3, rate: overageRecipients }])
		).toBe(3000);
	});
});

describe("Box billing rules", () => {
	it("bill every start for at least five minutes, in whole minutes", () => {
		expect(BOX_MINIMUM_SECONDS_PER_START).toBe(300);
		expect(BOX_BILLING_ROUNDING_SECONDS).toBe(60);
		expect(boxBillableSeconds(0)).toBe(300);
		expect(boxBillableSeconds(1)).toBe(300);
		expect(boxBillableSeconds(299)).toBe(300);
		expect(boxBillableSeconds(300)).toBe(300);
		expect(boxBillableSeconds(301)).toBe(360);
		expect(boxBillableSeconds(359.2)).toBe(360);
		expect(boxBillableSeconds(3600)).toBe(3600);
		expect(boxBillableSeconds(3601)).toBe(3660);
		expect(boxBillableSeconds(-5)).toBe(300);
	});

	it("include 10 GiB of Box storage without a paid plan and 25 GiB with one", () => {
		expect(boxIncludedStorageGib(null)).toBe(10);
		expect(boxIncludedStorageGib("desktop-license")).toBe(10);
		expect(boxIncludedStorageGib("marketplace-membership")).toBe(10);
		for (const plan of [
			"plus",
			"pro",
			"max",
			"teams-lite",
			"teams",
			"business",
		] as const) {
			expect(boxIncludedStorageGib(plan)).toBe(25);
		}
		expect(PLAN_IDS.length).toBe(8);
	});

	it("match the shared Box rate fixture the Gateway, Core and Box service read", () => {
		const fixture = JSON.parse(
			readFileSync(
				new URL(
					"../../../../crates/gateway/contracts/fixtures/box-rates.json",
					import.meta.url
				),
				"utf8"
			)
		);
		expect(fixture.sizeMicroUsdPerHour).toEqual({
			...BOX_SIZE_MICRO_USD_PER_HOUR,
		});
		expect(Object.keys(fixture.sizeMicroUsdPerHour)).toEqual([...BOX_SIZES]);
		expect(fixture.minimumSecondsPerStart).toBe(BOX_MINIMUM_SECONDS_PER_START);
		expect(fixture.roundingSeconds).toBe(BOX_BILLING_ROUNDING_SECONDS);
		expect(fixture.storage.microUsdPerGibMonth).toBe(
			BOX_STORAGE_MICRO_USD_PER_GIB_MONTH
		);
		expect(fixture.storage.monthDays * 86_400).toBe(
			SERVICE_BILLING_MONTH_SECONDS
		);
		expect(fixture.storage.includedGibPerOrg).toEqual({
			...BOX_INCLUDED_STORAGE_GIB,
		});
		const { meters } = SERVICE_RATES.box;
		expect([
			meters.boxSmallSeconds.microUsd,
			meters.boxDefaultSeconds.microUsd,
			meters.boxLargeSeconds.microUsd,
		]).toEqual([
			fixture.sizeMicroUsdPerHour.small,
			fixture.sizeMicroUsdPerHour.default,
			fixture.sizeMicroUsdPerHour.large,
		]);
	});
});

describe("chargeableAfterFreeAllowance", () => {
	it("charges only the part of a window past the monthly allowance", () => {
		const free = 10_000;
		const charge = (monthToDateBefore: number, quantity: number) =>
			chargeableAfterFreeAllowance({
				freePerMonth: free,
				monthToDateBefore,
				quantity,
			});
		expect(charge(0, 9999)).toBe(0);
		expect(charge(9999, 1)).toBe(0);
		expect(charge(9999, 2)).toBe(1);
		expect(charge(10_000, 5)).toBe(5);
		expect(charge(5000, 7000)).toBe(2000);
		expect(charge(12_000, 0)).toBe(0);
		expect(
			chargeableAfterFreeAllowance({
				freePerMonth: 0,
				monthToDateBefore: 0,
				quantity: 7,
			})
		).toBe(7);
	});
});
