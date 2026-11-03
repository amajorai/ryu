//! Debit arithmetic and boot validation for `CreditsConfig`.

use super::*;

impl CreditsConfig {
    /// Whether this gateway provider is configured as raw-cost pass-through.
    /// Provider ids are operational strings, so matching is trimmed and
    /// case-insensitive while preserving the configured spelling on the wire.
    pub fn is_pass_through_provider(&self, provider: &str) -> bool {
        let provider = provider.trim();
        !provider.is_empty()
            && self.provider_billing.iter().any(|(configured, policy)| {
                configured.as_str().eq_ignore_ascii_case(provider)
                    && policy.mode == ProviderBillingMode::PassThrough
            })
    }

    /// The amount to debit (micro-USD) for a call costing `cost_micro_usd`, after
    /// applying the platform markup. Round-half-up; saturating to avoid overflow.
    /// With `markup_bps == 0` this is the identity (pass-through at cost).
    pub fn debit_amount(&self, cost_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        cost_micro_usd
            .saturating_mul(BPS_DENOM.saturating_add(self.markup_bps))
            .saturating_add(BPS_DENOM / 2)
            / BPS_DENOM
    }

    /// The charged amount for a raw provider cost, using the provider-level
    /// pass-through policy when one is configured and the global markup for all
    /// other providers. `None` keeps the legacy global-markup behavior for
    /// unattributed charges.
    pub fn debit_amount_for_provider(&self, provider: Option<&str>, cost_micro_usd: u64) -> u64 {
        if provider.is_some_and(|name| self.is_pass_through_provider(name)) {
            cost_micro_usd
        } else {
            self.debit_amount(cost_micro_usd)
        }
    }

    /// The inverse of [`Self::debit_amount`]: the raw provider cost whose debit
    /// would come to at most `debit_micro_usd`.
    ///
    /// Needed to size a spend ceiling. A budget is denominated in CHARGED
    /// micro-USD, but a token ceiling has to be computed from RAW provider cost,
    /// so converting the wrong way round (or not at all) hands out a ceiling the
    /// subsequent debit then exceeds — which is precisely the overdraft the
    /// ceiling exists to prevent.
    ///
    /// Rounds DOWN, deliberately, and does not round-half-up the way
    /// `debit_amount` does: this is a ceiling, so the error must fall on the side
    /// of charging less than the budget rather than a hair more.
    pub fn undo_debit_amount(&self, debit_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        let scale = BPS_DENOM.saturating_add(self.markup_bps);
        if scale == 0 {
            return debit_micro_usd;
        }
        debit_micro_usd.saturating_mul(BPS_DENOM) / scale
    }

    /// Inverse of [`Self::debit_amount_for_provider`], used when a charged
    /// wallet headroom must be converted into a raw-cost or token ceiling.
    pub fn undo_debit_amount_for_provider(
        &self,
        provider: Option<&str>,
        debit_micro_usd: u64,
    ) -> u64 {
        if provider.is_some_and(|name| self.is_pass_through_provider(name)) {
            debit_micro_usd
        } else {
            self.undo_debit_amount(debit_micro_usd)
        }
    }

    /// The raw (pre-markup) cost in micro-USD for `n` billable tool calls. Pass
    /// the result through [`Self::debit_amount`] to apply the platform markup,
    /// Refuse a configuration that meters money but charges nothing for it.
    ///
    /// A per-call rate of 0 means the customer's wallet is debited NOTHING while
    /// the upstream provider still invoices us — Composio bills per action
    /// execution, and image/video/TTS/STT all carry real per-call costs. Every
    /// one of those rates used to default to 0; they now default to a real
    /// number, so reaching 0 takes an explicit key in the deploy config.
    ///
    /// That old default was justified as protecting OSS self-hosters. It did not:
    /// `enabled` is ALSO false by default, so a self-hosted gateway performs no
    /// debits at all regardless of the rates. The only deployment that reaches
    /// these fields is one that deliberately switched billing ON — which makes a
    /// zero rate a misconfiguration in every case that can actually occur, not a
    /// supported mode. It is a silent one, too: nothing errors, requests succeed,
    /// and the loss shows up as a provider invoice with no matching revenue.
    ///
    /// So: with credits enabled, an EXPLICIT zero on a synchronously-served rate
    /// is a hard startup failure. An *unset* rate is not — it resolves to the
    /// field's `default = "fn"`, which is the change that let this gate be widened
    /// back out without keeping nodes down while an operator invents numbers. The
    /// escape hatch is explicit rather than implicit — set
    /// `GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1` to deliberately give a modality
    /// away, which leaves a decision in the deploy config instead of a blank.
    pub fn validate_metered_rates(&self) -> anyhow::Result<()> {
        if !self.enabled {
            return Ok(());
        }
        if std::env::var("GATEWAY_CREDITS_ALLOW_FREE_MODALITIES")
            .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        {
            return Ok(());
        }

        // A ZERO IS ONLY EVER A DELIBERATE ONE NOW.
        //
        // This used to hard-fail on all five per-call rates, and was then cut
        // back to the tool rate alone because a managed node would not boot until
        // an operator had invented numbers — a gate demanding configuration that
        // kept nodes down at exactly the moment someone was restarting one. That
        // reason is gone: every rate this checks now carries a real `default =
        // "fn"`, so an unset key resolves to a working number and the gate can
        // only trip when a deployment writes an explicit `0`. Refusing an
        // explicit 0 costs a booting node nothing and is the whole point.
        //
        // The premise the cut-back was argued on was WRONG, and it is worth
        // stating plainly because it let a zero rate through twice: the claim was
        // that "image and video are metered from the provider's REPORTED cost, so
        // a flat rate of 0 there is a fallback that is never reached". That is
        // true of the SYNCHRONOUS media path only. The async video job debits
        // after the render, out of band, and its provider payload may carry no
        // compute time at all — so it lands on the flat rate, hits the `if cost >
        // 0` guard, and bills nothing. See
        // `an_async_video_job_bills_from_the_provider_payload_not_the_flat_rate`.
        //
        // Every media fallback is gated here alongside tool calls. Image and
        // video usually have a provider timing value, but the fallback is still
        // reachable for async jobs and providers that report no timing. A zero
        // fallback would otherwise skip the debit under the `cost > 0` guard.
        if self.cost_per_tool_call_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD is 0, \
so every Composio tool call bills the customer nothing while Composio still charges us. \
Unset it to take the at-cost default (500 = $0.50/1k, Composio's managed-app rate), or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give tool calls away on purpose."
            );
        }
        if self.cost_per_tts_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_TTS_MICRO_USD is 0, \
so every TTS synthesis bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give TTS away on purpose."
            );
        }
        if self.cost_per_stt_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_STT_MICRO_USD is 0, \
so every STT transcription bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give STT away on purpose."
            );
        }
        if self.cost_per_image_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_IMAGE_MICRO_USD is 0, \
so an image without provider compute timing bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give images away on purpose."
            );
        }
        if self.cost_per_video_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_VIDEO_MICRO_USD is 0, \
so an async video job without provider compute timing bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give videos away on purpose."
            );
        }
        Ok(())
    }

    /// exactly like token cost. Saturating to avoid overflow.
    pub fn tool_call_cost_micro_usd(&self, n: u64) -> u64 {
        self.cost_per_tool_call_micro_usd.saturating_mul(n)
    }

    /// The raw (pre-markup) flat cost in micro-USD for one successful media call
    /// of `modality`. Chat is never metered here (it uses real token/usage.cost);
    /// returns 0 for Chat and for any modality whose per-call rate is unset. Pass
    /// through [`Self::debit_amount`] to apply the platform markup, like tokens.
    /// Cost for one media call, preferring provider-reported `usage.cost`, then
    /// reported compute time, and finally the configured flat rate.
    ///
    /// Returns the amount and whether it was ESTIMATED. The flag is not
    /// decoration: a flat-rate fallback is a guess, and recording which ledger
    /// rows were guesses is what makes a later reconciliation against the
    /// provider's own invoice possible. Without it, an estimate and a measured
    /// charge are indistinguishable after the fact.
    pub fn media_cost_from_response(
        &self,
        modality: &Modality,
        response: &serde_json::Value,
    ) -> (u64, bool) {
        // OpenRouter's image adapter preserves the original chat response under
        // `raw`, while other providers commonly leave `usage` at the top level.
        // Prefer either provider-reported cost before using a local estimate.
        let reported_cost_usd = response
            .get("usage")
            .and_then(|usage| usage.get("cost"))
            .or_else(|| {
                response
                    .get("raw")
                    .and_then(|raw| raw.get("usage"))
                    .and_then(|usage| usage.get("cost"))
            })
            .and_then(serde_json::Value::as_f64)
            .filter(|cost| cost.is_finite() && *cost >= 0.0);
        if let Some(cost_usd) = reported_cost_usd {
            return (((cost_usd * 1_000_000.0).round()).max(0.0) as u64, false);
        }

        let seconds = response
            .get("usage")
            .and_then(|u| u.get("compute_seconds"))
            .and_then(serde_json::Value::as_f64)
            .filter(|s| *s > 0.0);
        if let Some(seconds) = seconds {
            if self.cost_per_gpu_second_micro_usd > 0 {
                // Round UP: a partial second of GPU time is a second we are
                // billed for, and rounding down would leak a sliver on every
                // call.
                let micro = (seconds * self.cost_per_gpu_second_micro_usd as f64).ceil();
                return (micro.max(0.0) as u64, false);
            }
        }
        // Speech synthesis and voice recognition have no provider-reported cost
        // or compute-time path, so their configured per-call rate is the actual
        // price rather than an estimate. Image, video and generated audio are the
        // modalities where this flat amount is a fallback.
        (
            self.media_cost_micro_usd(modality),
            matches!(
                modality,
                Modality::Image | Modality::Video | Modality::Audio
            ),
        )
    }

    /// The flat configured rate for a modality. For image/video it is THE
    /// FALLBACK, never the primary price; Audio/Voice Recognition have no
    /// provider-reported cost path, so this configured per-call amount is their
    /// actual price.
    ///
    /// PRIVATE ON PURPOSE. Call {@link media_cost_from_response} instead, which
    /// prefers the provider's reported compute time and returns a flag saying
    /// which of the two paid, so the ledger can mark an estimated row.
    ///
    /// This was `pub`, and the async video-job debit reached past
    /// `media_cost_from_response` to call it directly. `cost_per_video_micro_usd`
    /// then defaulted to 0 and the debit is guarded by `if cost > 0`, so every
    /// completed async video job billed NOTHING under the default config — while
    /// the startup gate had stopped guarding the video rate precisely because
    /// video was believed to be metered from provider cost. Narrowing the
    /// visibility is what makes that combination unrepresentable rather than
    /// merely fixed; giving all four rates a non-zero default is what removes the
    /// other half of it.
    pub(super) fn media_cost_micro_usd(&self, modality: &Modality) -> u64 {
        match modality {
            Modality::Image => self.cost_per_image_micro_usd,
            // Generated audio is a queued cloud job priced like video: from the
            // provider's reported compute time first, with the video flat rate as
            // the marked fallback. Reusing that rate keeps the startup gate's
            // non-zero guarantee instead of adding an unguarded new knob.
            Modality::Video | Modality::Audio => self.cost_per_video_micro_usd,
            Modality::Tts => self.cost_per_tts_micro_usd,
            Modality::Stt => self.cost_per_stt_micro_usd,
            Modality::Chat => 0,
        }
    }

    /// Whether the hook is active: enabled with both a non-empty control-plane
    /// URL and a non-empty internal secret. Without the secret the control plane
    /// rejects the debit, so startup validation must not allow a silently
    /// unmetered enabled configuration.
    pub fn is_active(&self) -> bool {
        self.enabled
            && self
                .internal_secret
                .as_deref()
                .is_some_and(|secret| !secret.trim().is_empty())
            && !self.base_url.trim().is_empty()
    }

    /// Per-GPU-second rate in nano-USD for a GPU tier. `None` costs nothing.
    pub fn gpu_rate_nano(&self, gpu: GpuKind) -> u64 {
        match gpu {
            GpuKind::None => 0,
            GpuKind::H200 => self.cost_per_sandbox_gpu_h200_second_nano_usd,
            GpuKind::H100 => self.cost_per_sandbox_gpu_h100_second_nano_usd,
            GpuKind::RtxPro6000 => self.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
            GpuKind::Rtx5090 => self.cost_per_sandbox_gpu_rtx_5090_second_nano_usd,
            GpuKind::Rtx4090 => self.cost_per_sandbox_gpu_rtx_4090_second_nano_usd,
        }
    }

    /// Raw (pre-markup) cost of one sandbox tick in MICRO-USD. Takes primitive
    /// args so this module does not depend on the metering route's `SandboxSpec`.
    /// Rates are summed in nano-USD per second, multiplied by `seconds`, then
    /// converted once to micro-USD (round-half-up). Storage is billed only above
    /// the free tier; a GPU count of 0 with a non-`None` tier bills as 1.
    pub fn sandbox_tick_cost_raw_micro(
        &self,
        vcpu: u32,
        mem_gib: u32,
        storage_gib: u32,
        gpu: GpuKind,
        gpu_count: u32,
        os: OsKind,
        seconds: u64,
    ) -> u64 {
        let vcpu = u64::from(vcpu);
        let billable_storage = u64::from(storage_gib).saturating_sub(self.sandbox_free_storage_gib);
        let eff_gpu = match gpu {
            GpuKind::None => 0,
            _ => u64::from(gpu_count.max(1)),
        };
        let per_sec_nano = vcpu
            .saturating_mul(self.cost_per_sandbox_vcpu_second_nano_usd)
            .saturating_add(
                u64::from(mem_gib).saturating_mul(self.cost_per_sandbox_mem_gib_second_nano_usd),
            )
            .saturating_add(
                billable_storage.saturating_mul(self.cost_per_sandbox_storage_gib_second_nano_usd),
            )
            .saturating_add(eff_gpu.saturating_mul(self.gpu_rate_nano(gpu)))
            .saturating_add(match os {
                OsKind::Windows => {
                    vcpu.saturating_mul(self.cost_per_sandbox_windows_vcpu_second_nano_usd)
                }
                OsKind::Linux => 0,
            });
        let total_nano = per_sec_nano.saturating_mul(seconds);
        // nano -> micro, round half up.
        total_nano.saturating_add(500) / 1_000
    }

    /// The amount to debit (micro-USD) for a sandbox tick costing
    /// `cost_micro_usd`, after applying the sandbox markup. SEPARATE from
    /// [`Self::debit_amount`]: this uses `sandbox_markup_bps` (default 3000 ⇒
    /// × 1.30), not the global at-cost `markup_bps`. Round-half-up, saturating.
    pub fn sandbox_debit_amount(&self, cost_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        cost_micro_usd
            .saturating_mul(BPS_DENOM.saturating_add(self.sandbox_markup_bps))
            .saturating_add(BPS_DENOM / 2)
            / BPS_DENOM
    }

    /// The size-rate debit (micro-USD) for `seconds` of a Box of `size`, or
    /// `None` when no size rates are configured. Round-half-up, saturating,
    /// with no sandbox markup: the size rate is the customer price.
    pub fn sandbox_size_debit_micro(&self, size: SandboxSize, seconds: u64) -> Option<u64> {
        const SECONDS_PER_HOUR: u64 = 3600;
        let rate = self.sandbox_size_rates?.micro_usd_per_hour(size);
        Some(
            rate.saturating_mul(seconds)
                .saturating_add(SECONDS_PER_HOUR / 2)
                / SECONDS_PER_HOUR,
        )
    }
}

#[cfg(test)]
#[path = "tests/credits_config_tests.rs"]
mod credits_config_tests;
