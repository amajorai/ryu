use std::sync::OnceLock;
use std::time::{Duration, Instant};

use dashmap::DashMap;

use crate::config::WidgetConfig;

// ── Per-widget-instance rate limiter (Ryu Apps, §4.3) ────────────────────────
//
// A process-global rolling-minute token bucket per widget instance. It is a
// static rather than a field on `AppState` because it is self-contained
// governance that BOTH `check_exec_budget` (the pre-run gate) and the
// `exec_tool` widget chain (D5) consult, without threading new state through the
// whole app. Keyed by `"<kind>:<instance_id>"` so a widget's `callTool` and
// `sendFollowUpMessage` buckets are independent, and one rendered widget can
// never drain another's budget.

pub(super) struct WidgetBucket {
    pub(super) window_start: Instant,
    pub(super) count: u32,
}

/// Map size at which expired widget buckets are swept (see `try_consume`).
pub(super) const WIDGET_BUCKET_SWEEP_THRESHOLD: usize = 4096;

#[derive(Default)]
pub(super) struct WidgetRateLimiter {
    pub(super) buckets: DashMap<String, WidgetBucket>,
}

impl WidgetRateLimiter {
    /// Try to consume one token for `key` under `max_per_min`. Returns `true`
    /// when allowed (and records the use); `false` when this minute's budget is
    /// spent. `max_per_min == 0` ⇒ unlimited.
    pub(super) fn try_consume(&self, key: String, max_per_min: u32) -> bool {
        if max_per_min == 0 {
            return true;
        }
        // Every rendered widget instance mints a fresh key, so without a sweep
        // the process-global map grows for the life of the gateway. A bucket
        // whose window has elapsed carries no state (it would reset on next
        // use), so dropping it is lossless. Swept before taking the entry ref:
        // `retain` locks every shard and would deadlock against a held ref.
        if self.buckets.len() >= WIDGET_BUCKET_SWEEP_THRESHOLD {
            self.buckets
                .retain(|_, bucket| bucket.window_start.elapsed() < Duration::from_secs(60));
        }
        let mut bucket = self.buckets.entry(key).or_insert_with(|| WidgetBucket {
            window_start: Instant::now(),
            count: 0,
        });
        if bucket.window_start.elapsed() >= Duration::from_secs(60) {
            bucket.window_start = Instant::now();
            bucket.count = 0;
        }
        if bucket.count >= max_per_min {
            return false;
        }
        bucket.count += 1;
        true
    }
}

fn widget_limiter() -> &'static WidgetRateLimiter {
    static LIMITER: OnceLock<WidgetRateLimiter> = OnceLock::new();
    LIMITER.get_or_init(WidgetRateLimiter::default)
}

/// Consume one widget `callTool` token for `instance_id`. Returns `false` when
/// the per-instance per-minute call budget is spent. A disabled widget section
/// (`enabled = false`) or `max_calls_per_min == 0` is always allowed.
pub fn widget_call_allowed(cfg: &WidgetConfig, instance_id: &str) -> bool {
    if !cfg.enabled {
        return true;
    }
    widget_limiter().try_consume(format!("call:{instance_id}"), cfg.max_calls_per_min)
}

/// Consume one widget `sendFollowUpMessage` token for `instance_id` (stricter
/// than `callTool`). Returns `false` when the per-instance per-minute follow-up
/// budget is spent. Consumed by the follow-up authorization path (§4.2, gate 4);
/// exposed here as the single owner of the widget token buckets. `dead_code`
/// until the follow-up ingest handler wires it, so the bucket lives in one place.
#[allow(dead_code)]
pub fn widget_followup_allowed(cfg: &WidgetConfig, instance_id: &str) -> bool {
    if !cfg.enabled {
        return true;
    }
    widget_limiter().try_consume(format!("followup:{instance_id}"), cfg.max_followups_per_min)
}

#[cfg(test)]
mod tests {
    use super::{
        widget_call_allowed, widget_followup_allowed, WidgetBucket, WidgetRateLimiter,
        WIDGET_BUCKET_SWEEP_THRESHOLD,
    };

    #[test]
    fn widget_bucket_is_unlimited_at_zero_and_caps_at_max() {
        let limiter = WidgetRateLimiter::default();
        // 0 = unlimited: always allowed.
        assert!(limiter.try_consume("k0".to_string(), 0));
        assert!(limiter.try_consume("k0".to_string(), 0));
        // max=2: two allowed, the third denied within the same minute.
        assert!(limiter.try_consume("k2".to_string(), 2));
        assert!(limiter.try_consume("k2".to_string(), 2));
        assert!(!limiter.try_consume("k2".to_string(), 2));
        // A different key has its own independent budget.
        assert!(limiter.try_consume("other".to_string(), 2));
    }

    #[test]
    fn widget_buckets_with_elapsed_windows_are_swept() {
        let limiter = WidgetRateLimiter::default();
        let Some(expired) =
            std::time::Instant::now().checked_sub(std::time::Duration::from_secs(120))
        else {
            return;
        };
        for index in 0..WIDGET_BUCKET_SWEEP_THRESHOLD {
            limiter.buckets.insert(
                format!("call:stale-{index}"),
                WidgetBucket {
                    window_start: expired,
                    count: 1,
                },
            );
        }
        assert!(limiter.try_consume("call:live".to_string(), 2));
        assert_eq!(limiter.buckets.len(), 1, "only the live bucket remains");
        assert!(limiter.try_consume("call:live".to_string(), 2));
        assert!(!limiter.try_consume("call:live".to_string(), 2));
    }

    #[test]
    fn widget_call_and_followup_allowed_bypass_when_disabled() {
        let mut cfg = crate::config::WidgetConfig::default();
        cfg.enabled = false;
        // Disabled ⇒ always allowed regardless of the (unique) instance.
        assert!(widget_call_allowed(&cfg, "inst-disabled-call"));
        assert!(widget_followup_allowed(&cfg, "inst-disabled-followup"));

        // Enabled with a tiny follow-up budget ⇒ the (stricter) bucket exhausts.
        cfg.enabled = true;
        cfg.max_followups_per_min = 1;
        assert!(widget_followup_allowed(&cfg, "inst-strict"));
        assert!(!widget_followup_allowed(&cfg, "inst-strict"));
    }
}
