use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::timeline::TimelineEntry;

const MICROS_PER_MINUTE: u64 = 60_000_000;
const DEFAULT_CARD_GAP_US: u64 = 7 * MICROS_PER_MINUTE;
const MIN_CARD_DURATION_US: u64 = MICROS_PER_MINUTE;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalSnapshot {
    pub start_ts: u64,
    pub end_ts: u64,
    pub cards: Vec<JournalCard>,
    pub categories: Vec<JournalStat>,
    pub apps: Vec<JournalStat>,
    pub standup: StandupDraft,
    pub focus: FocusStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalCard {
    pub id: String,
    pub start_ts: u64,
    pub end_ts: u64,
    pub title: String,
    pub summary: String,
    /// Dayflow-style "detailed summary": a reconstruction-grade recap of the
    /// card. Deterministically templated; upgraded in place by the optional
    /// LLM narration pass (`apps/shadow` journal narrator).
    pub detailed_summary: String,
    pub category: String,
    pub primary_app: String,
    pub event_count: u32,
    /// True when the card as a whole is a distraction (idle/entertainment).
    pub distraction: bool,
    /// Brief (<5 min) unrelated interruptions *inside* an otherwise focused
    /// card. Empty from the deterministic pass; populated by the narrator.
    pub distractions: Vec<CardDistraction>,
}

/// A short distraction nested inside a focused card (Dayflow model): a 2–5 min
/// detour that does not split the card. Ranges are advisory (narrator-supplied).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardDistraction {
    pub title: String,
    pub summary: String,
    pub start_ts: u64,
    pub end_ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalStat {
    pub name: String,
    pub minutes: u32,
    pub event_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StandupDraft {
    pub highlights: Vec<String>,
    pub tasks: Vec<String>,
    pub blockers: Vec<String>,
}

/// Focus-vs-distraction analytics for a range, derived purely from cards. This
/// is the headline metric of the retrospective surface (Dayflow's focus view).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FocusStats {
    /// Minutes on non-distraction cards (Deep Work, Communication, Work, …).
    pub focus_minutes: u32,
    /// Minutes on distraction cards.
    pub distraction_minutes: u32,
    /// Subset of focus: minutes classified specifically as Deep Work.
    pub deep_work_minutes: u32,
    /// Subset of focus: minutes classified as Communication.
    pub communication_minutes: u32,
    /// focus / (focus + distraction), in 0.0..=1.0. Zero when nothing captured.
    pub focus_ratio: f32,
    /// Longest uninterrupted run of focus minutes (streak across adjacent
    /// non-distraction cards).
    pub longest_focus_streak_minutes: u32,
    /// focus_minutes + distraction_minutes.
    pub total_minutes: u32,
}

/// A week-long retrospective aggregated from up to 7 daily snapshots. Pure:
/// callers supply the daily snapshots (DB-backed) and this folds them together.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeeklyReview {
    pub start_ts: u64,
    pub end_ts: u64,
    pub days: Vec<DailyRollup>,
    pub categories: Vec<JournalStat>,
    pub apps: Vec<JournalStat>,
    pub focus: FocusStats,
    /// Week highlights: the most notable focused card titles across the week.
    pub highlights: Vec<String>,
}

/// One day's compressed line in the weekly review.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyRollup {
    /// Caller-supplied day label (e.g. "2026-07-08" or "Mon"). Opaque here.
    pub day: String,
    pub start_ts: u64,
    pub focus_minutes: u32,
    pub distraction_minutes: u32,
    pub focus_ratio: f32,
    pub card_count: u32,
    pub top_category: String,
}

#[derive(Default)]
struct CardBucket {
    start_ts: u64,
    end_ts: u64,
    entries: Vec<TimelineEntry>,
}

pub fn build_journal_snapshot(
    start_ts: u64,
    end_ts: u64,
    entries: &[TimelineEntry],
) -> JournalSnapshot {
    let cards = build_cards(entries);
    let categories = stats_by(&cards, |card| card.category.as_str());
    let apps = stats_by(&cards, |card| card.primary_app.as_str());
    let standup = build_standup(&cards);
    let focus = compute_focus_stats(&cards);

    JournalSnapshot {
        start_ts,
        end_ts,
        cards,
        categories,
        apps,
        standup,
        focus,
    }
}

/// Minutes a card occupies, floored at one minute (matches `stats_by`).
fn card_minutes(card: &JournalCard) -> u32 {
    let micros = card
        .end_ts
        .saturating_sub(card.start_ts)
        .max(MIN_CARD_DURATION_US);
    u32::try_from(micros / MICROS_PER_MINUTE)
        .unwrap_or(u32::MAX)
        .max(1)
}

/// Derive focus-vs-distraction analytics from an ordered-or-unordered set of
/// cards. The longest-streak walk sorts defensively so callers need not.
pub fn compute_focus_stats(cards: &[JournalCard]) -> FocusStats {
    let mut focus_minutes: u32 = 0;
    let mut distraction_minutes: u32 = 0;
    let mut deep_work_minutes: u32 = 0;
    let mut communication_minutes: u32 = 0;

    for card in cards {
        let minutes = card_minutes(card);
        if card.distraction {
            distraction_minutes = distraction_minutes.saturating_add(minutes);
        } else {
            focus_minutes = focus_minutes.saturating_add(minutes);
            match card.category.as_str() {
                "Deep Work" => deep_work_minutes = deep_work_minutes.saturating_add(minutes),
                "Communication" => {
                    communication_minutes = communication_minutes.saturating_add(minutes)
                }
                _ => {}
            }
        }
    }

    let total_minutes = focus_minutes.saturating_add(distraction_minutes);
    let focus_ratio = if total_minutes == 0 {
        0.0
    } else {
        focus_minutes as f32 / total_minutes as f32
    };

    // Longest uninterrupted focus streak across adjacent (by time) cards.
    let mut ordered: Vec<&JournalCard> = cards.iter().collect();
    ordered.sort_by_key(|card| card.start_ts);
    let mut streak: u32 = 0;
    let mut longest_focus_streak_minutes: u32 = 0;
    for card in ordered {
        if card.distraction {
            streak = 0;
        } else {
            streak = streak.saturating_add(card_minutes(card));
            longest_focus_streak_minutes = longest_focus_streak_minutes.max(streak);
        }
    }

    FocusStats {
        focus_minutes,
        distraction_minutes,
        deep_work_minutes,
        communication_minutes,
        focus_ratio,
        longest_focus_streak_minutes,
        total_minutes,
    }
}

/// Fold up to seven daily snapshots into a weekly retrospective. Pure: the
/// caller supplies `(day_label, snapshot)` pairs (typically one per day from
/// `query_journal_snapshot`), already ordered oldest→newest.
pub fn build_weekly_review(
    start_ts: u64,
    end_ts: u64,
    days: &[(String, JournalSnapshot)],
) -> WeeklyReview {
    let mut category_totals: BTreeMap<String, (u64, u32)> = BTreeMap::new();
    let mut app_totals: BTreeMap<String, (u64, u32)> = BTreeMap::new();
    let mut rollups: Vec<DailyRollup> = Vec::with_capacity(days.len());
    let mut all_cards: Vec<JournalCard> = Vec::new();

    for (day, snapshot) in days {
        for stat in &snapshot.categories {
            let entry = category_totals.entry(stat.name.clone()).or_default();
            entry.0 += u64::from(stat.minutes);
            entry.1 = entry.1.saturating_add(stat.event_count);
        }
        for stat in &snapshot.apps {
            let entry = app_totals.entry(stat.name.clone()).or_default();
            entry.0 += u64::from(stat.minutes);
            entry.1 = entry.1.saturating_add(stat.event_count);
        }

        let top_category = snapshot
            .categories
            .first()
            .map(|stat| stat.name.clone())
            .unwrap_or_else(|| "Work".into());

        rollups.push(DailyRollup {
            day: day.clone(),
            start_ts: snapshot.start_ts,
            focus_minutes: snapshot.focus.focus_minutes,
            distraction_minutes: snapshot.focus.distraction_minutes,
            focus_ratio: snapshot.focus.focus_ratio,
            card_count: u32::try_from(snapshot.cards.len()).unwrap_or(u32::MAX),
            top_category,
        });

        all_cards.extend(snapshot.cards.iter().cloned());
    }

    let highlights = all_cards
        .iter()
        .filter(|card| !card.distraction && card.category != "Communication")
        .take(6)
        .map(|card| card.title.clone())
        .collect::<Vec<_>>();

    WeeklyReview {
        start_ts,
        end_ts,
        days: rollups,
        categories: sorted_stats(category_totals),
        apps: sorted_stats(app_totals),
        focus: compute_focus_stats(&all_cards),
        highlights: non_empty_or_placeholder(highlights, "No focused work captured this week."),
    }
}

/// Turn accumulated `(minutes, event_count)` totals into a sorted stat list.
fn sorted_stats(totals: BTreeMap<String, (u64, u32)>) -> Vec<JournalStat> {
    let mut out: Vec<JournalStat> = totals
        .into_iter()
        .map(|(name, (minutes, event_count))| JournalStat {
            name,
            minutes: u32::try_from(minutes).unwrap_or(u32::MAX),
            event_count,
        })
        .collect();
    out.sort_by(|a, b| {
        b.minutes
            .cmp(&a.minutes)
            .then_with(|| b.event_count.cmp(&a.event_count))
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// Recompute every card-derived aggregate (categories, apps, standup, focus)
/// after `snapshot.cards` has been replaced in place — e.g. by the optional LLM
/// narrator, which rewrites card *text* only. Card ranges/categories are
/// preserved by the narrator, so the numeric aggregates are stable; the standup
/// is refreshed so its bullets use the narrated titles.
pub fn rebuild_derived(snapshot: &mut JournalSnapshot) {
    snapshot.categories = stats_by(&snapshot.cards, |card| card.category.as_str());
    snapshot.apps = stats_by(&snapshot.cards, |card| card.primary_app.as_str());
    snapshot.standup = build_standup(&snapshot.cards);
    snapshot.focus = compute_focus_stats(&snapshot.cards);
}

fn build_cards(entries: &[TimelineEntry]) -> Vec<JournalCard> {
    let mut ordered: Vec<TimelineEntry> = entries
        .iter()
        .filter(|entry| meaningful_entry(entry))
        .cloned()
        .collect();
    ordered.sort_by_key(|entry| entry.ts);

    let mut buckets: Vec<CardBucket> = Vec::new();
    for entry in ordered {
        match buckets.last_mut() {
            Some(bucket) if should_merge(bucket, &entry) => {
                bucket.end_ts = entry.ts;
                bucket.entries.push(entry);
            }
            _ => buckets.push(CardBucket {
                start_ts: entry.ts,
                end_ts: entry.ts.saturating_add(MIN_CARD_DURATION_US),
                entries: vec![entry],
            }),
        }
    }

    buckets
        .into_iter()
        .enumerate()
        .map(|(index, bucket)| bucket_to_card(index, bucket))
        .collect()
}

fn should_merge(bucket: &CardBucket, entry: &TimelineEntry) -> bool {
    let app = normalized_app(entry);
    let category = classify_entry(entry);
    let previous_app = bucket
        .entries
        .last()
        .map(normalized_app)
        .unwrap_or_else(|| app.clone());
    let previous_category = bucket
        .entries
        .last()
        .map(classify_entry)
        .unwrap_or_else(|| category.clone());
    let gap = entry.ts.saturating_sub(bucket.end_ts);

    gap <= DEFAULT_CARD_GAP_US && (app == previous_app || category == previous_category)
}

fn bucket_to_card(index: usize, bucket: CardBucket) -> JournalCard {
    let category = dominant_value(&bucket.entries, classify_entry).unwrap_or_else(|| "Work".into());
    let primary_app =
        dominant_value(&bucket.entries, normalized_app).unwrap_or_else(|| "Unknown".into());
    let title = card_title(&bucket.entries, &primary_app, &category);
    let event_count = u32::try_from(bucket.entries.len()).unwrap_or(u32::MAX);
    let distraction = category == "Distraction";
    let end_ts = bucket
        .end_ts
        .max(bucket.start_ts.saturating_add(MIN_CARD_DURATION_US));

    let summary = card_summary(event_count, &primary_app, &category, &bucket.entries);
    let detailed_summary = card_detailed_summary(&bucket.entries, &primary_app);

    JournalCard {
        id: format!("journal-{}-{}", bucket.start_ts, index),
        start_ts: bucket.start_ts,
        end_ts,
        title,
        summary,
        detailed_summary,
        category,
        primary_app,
        event_count,
        distraction,
        distractions: Vec::new(),
    }
}

/// Deterministic reconstruction recap: the distinct window titles / URLs seen in
/// the bucket, in order. The LLM narrator replaces this with prose, but even the
/// raw list is a useful "what did I actually touch" recall aid.
fn card_detailed_summary(entries: &[TimelineEntry], primary_app: &str) -> String {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut lines: Vec<String> = Vec::new();
    for entry in entries {
        let label = entry
            .window_title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or_else(|| entry.url.as_deref().map(str::trim))
            .unwrap_or("");
        if label.is_empty() {
            continue;
        }
        if seen.insert(label.to_string()) {
            lines.push(label.to_string());
        }
        if lines.len() >= 8 {
            break;
        }
    }
    if lines.is_empty() {
        return format!("Activity in {primary_app}.");
    }
    format!("In {primary_app}: {}.", lines.join("; "))
}

fn meaningful_entry(entry: &TimelineEntry) -> bool {
    !matches!(
        entry.event_type.as_str(),
        "mouse_move" | "key_up" | "ax_snapshot"
    )
}

fn normalized_app(entry: &TimelineEntry) -> String {
    entry
        .app_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Unknown")
        .to_string()
}

fn classify_entry(entry: &TimelineEntry) -> String {
    let haystack = format!(
        "{} {} {}",
        entry.app_name.as_deref().unwrap_or_default(),
        entry.window_title.as_deref().unwrap_or_default(),
        entry.url.as_deref().unwrap_or_default()
    )
    .to_lowercase();

    if entry.event_type == "journal_marker" {
        return "Milestone".into();
    }
    if haystack.contains("youtube")
        || haystack.contains("netflix")
        || haystack.contains("tiktok")
        || haystack.contains("reddit")
        || haystack.contains("x.com")
        || haystack.contains("twitter")
    {
        return "Distraction".into();
    }
    if haystack.contains("zoom")
        || haystack.contains("meet")
        || haystack.contains("teams")
        || haystack.contains("slack")
        || haystack.contains("discord")
        || haystack.contains("mail")
        || haystack.contains("calendar")
    {
        return "Communication".into();
    }
    if haystack.contains("github")
        || haystack.contains("gitlab")
        || haystack.contains("cursor")
        || haystack.contains("code")
        || haystack.contains("terminal")
        || haystack.contains("powershell")
        || haystack.contains("rust")
        || haystack.contains("typescript")
    {
        return "Deep Work".into();
    }
    if entry.track == 9 || entry.track == 8 {
        return "Deep Work".into();
    }
    if entry.track == 10 || entry.track == 11 {
        return "Communication".into();
    }

    "Work".into()
}

fn dominant_value<F>(entries: &[TimelineEntry], f: F) -> Option<String>
where
    F: Fn(&TimelineEntry) -> String,
{
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    for entry in entries {
        *counts.entry(f(entry)).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
        .map(|(name, _)| name)
}

fn card_title(entries: &[TimelineEntry], primary_app: &str, category: &str) -> String {
    entries
        .iter()
        .rev()
        .find_map(|entry| {
            entry
                .window_title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(|title| format!("{primary_app}: {title}"))
        .unwrap_or_else(|| format!("{category} in {primary_app}"))
}

fn card_summary(
    event_count: u32,
    primary_app: &str,
    category: &str,
    entries: &[TimelineEntry],
) -> String {
    let distinct_apps = entries
        .iter()
        .map(normalized_app)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    if distinct_apps > 1 {
        format!("{category} across {distinct_apps} apps, led by {primary_app}.")
    } else {
        format!("{category} activity in {primary_app} from {event_count} captured signals.")
    }
}

fn stats_by<F>(cards: &[JournalCard], f: F) -> Vec<JournalStat>
where
    F: Fn(&JournalCard) -> &str,
{
    let mut stats: BTreeMap<String, (u64, u32)> = BTreeMap::new();
    for card in cards {
        let minutes = card
            .end_ts
            .saturating_sub(card.start_ts)
            .max(MIN_CARD_DURATION_US)
            / MICROS_PER_MINUTE;
        let entry = stats.entry(f(card).to_string()).or_default();
        entry.0 += minutes.max(1);
        entry.1 = entry.1.saturating_add(card.event_count);
    }
    let mut out: Vec<JournalStat> = stats
        .into_iter()
        .map(|(name, (minutes, event_count))| JournalStat {
            name,
            minutes: u32::try_from(minutes).unwrap_or(u32::MAX),
            event_count,
        })
        .collect();
    out.sort_by(|a, b| {
        b.minutes
            .cmp(&a.minutes)
            .then_with(|| b.event_count.cmp(&a.event_count))
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

fn build_standup(cards: &[JournalCard]) -> StandupDraft {
    let highlights = cards
        .iter()
        .filter(|card| !card.distraction && card.category != "Communication")
        .take(4)
        .map(|card| card.title.clone())
        .collect::<Vec<_>>();
    let tasks = cards
        .iter()
        .rev()
        .filter(|card| card.category == "Deep Work" || card.category == "Milestone")
        .take(3)
        .map(|card| format!("Continue: {}", card.title))
        .collect::<Vec<_>>();
    let blockers = cards
        .iter()
        .filter(|card| card.distraction)
        .take(3)
        .map(|card| format!("Potential drift: {}", card.title))
        .collect::<Vec<_>>();

    StandupDraft {
        highlights: non_empty_or_placeholder(highlights, "No focused work captured yet."),
        tasks: non_empty_or_placeholder(tasks, "No follow-up tasks inferred yet."),
        blockers: non_empty_or_placeholder(blockers, "No obvious blockers or drift detected."),
    }
}

fn non_empty_or_placeholder(mut values: Vec<String>, placeholder: &str) -> Vec<String> {
    if values.is_empty() {
        values.push(placeholder.to_string());
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: u64, app: &str, title: &str, event_type: &str) -> TimelineEntry {
        TimelineEntry {
            ts,
            track: 3,
            event_type: event_type.to_string(),
            app_name: Some(app.to_string()),
            window_title: Some(title.to_string()),
            url: None,
            display_id: None,
            segment_file: "segment.msgpack".to_string(),
        }
    }

    #[test]
    fn groups_adjacent_work_into_cards() {
        let entries = vec![
            entry(1_000_000, "Cursor", "Build journal", "app_switch"),
            entry(90_000_000, "Cursor", "Build journal", "ocr"),
            entry(
                20 * MICROS_PER_MINUTE,
                "Slack",
                "Daily standup",
                "app_switch",
            ),
        ];

        let snapshot = build_journal_snapshot(0, 30 * MICROS_PER_MINUTE, &entries);

        assert_eq!(snapshot.cards.len(), 2);
        assert_eq!(snapshot.cards[0].category, "Deep Work");
        assert_eq!(snapshot.cards[1].category, "Communication");
        assert_eq!(snapshot.apps[0].name, "Cursor");
    }

    #[test]
    fn marks_distraction_cards_as_blockers() {
        let entries = vec![entry(1_000_000, "Chrome", "YouTube", "app_switch")];

        let snapshot = build_journal_snapshot(0, MICROS_PER_MINUTE, &entries);

        assert!(snapshot.cards[0].distraction);
        assert!(snapshot.standup.blockers[0].contains("Potential drift"));
    }

    fn card(start_ts: u64, minutes: u64, category: &str, distraction: bool) -> JournalCard {
        JournalCard {
            id: format!("c-{start_ts}"),
            start_ts,
            end_ts: start_ts + minutes * MICROS_PER_MINUTE,
            title: format!("{category} card"),
            summary: String::new(),
            detailed_summary: String::new(),
            category: category.to_string(),
            primary_app: "App".into(),
            event_count: 1,
            distraction,
            distractions: Vec::new(),
        }
    }

    #[test]
    fn focus_stats_ratio_and_streak() {
        // 30m deep work, 10m distraction, 20m deep work → focus 50, distraction 10.
        let cards = vec![
            card(0, 30, "Deep Work", false),
            card(30 * MICROS_PER_MINUTE, 10, "Distraction", true),
            card(40 * MICROS_PER_MINUTE, 20, "Deep Work", false),
        ];

        let focus = compute_focus_stats(&cards);

        assert_eq!(focus.focus_minutes, 50);
        assert_eq!(focus.distraction_minutes, 10);
        assert_eq!(focus.deep_work_minutes, 50);
        assert_eq!(focus.total_minutes, 60);
        assert!((focus.focus_ratio - 50.0 / 60.0).abs() < 1e-6);
        // The distraction breaks the streak, so the longest run is the first 30m block.
        assert_eq!(focus.longest_focus_streak_minutes, 30);
    }

    #[test]
    fn focus_stats_empty_is_zeroed() {
        let focus = compute_focus_stats(&[]);
        assert_eq!(focus.total_minutes, 0);
        assert_eq!(focus.focus_ratio, 0.0);
    }

    #[test]
    fn weekly_review_aggregates_days() {
        let day_a = build_journal_snapshot(
            0,
            60 * MICROS_PER_MINUTE,
            &[entry(1_000_000, "Cursor", "Ship feature", "app_switch")],
        );
        let day_b = build_journal_snapshot(
            0,
            60 * MICROS_PER_MINUTE,
            &[entry(1_000_000, "Chrome", "YouTube", "app_switch")],
        );

        let review = build_weekly_review(
            0,
            2 * 24 * 60 * MICROS_PER_MINUTE,
            &[("Mon".into(), day_a), ("Tue".into(), day_b)],
        );

        assert_eq!(review.days.len(), 2);
        assert_eq!(review.days[0].day, "Mon");
        // Monday was focused work, Tuesday was a distraction.
        assert!(review.focus.focus_minutes >= 1);
        assert!(review.focus.distraction_minutes >= 1);
        assert!(!review.categories.is_empty());
    }
}
