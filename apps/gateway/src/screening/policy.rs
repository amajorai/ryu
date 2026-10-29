//! The platform floor's `screener` field (screener addendum section 5.3) and
//! the decision matrix it drives (spec 02.6.4).
//!
//! The field is a top-level wire key beside `overlay`, never inside it, so no
//! org, team, agent or request overlay has a path to it. This module parses
//! its structure, all or nothing: an unknown key, a bad threshold, S4 with an
//! action other than block, or a remote-processor record without a second
//! approver rejects the whole floor. Checks that need this replica's
//! endpoints (a role naming an unknown backend, a remote backend without a
//! record, a role that cannot cover S4 at all) run in
//! [`super::ScreeningRuntime::validate_floor`].
//!
//! Qualification is not a parse rule here. A floor whose hard codes have no
//! qualified source is accepted, and the replica runs the section 6 "no
//! qualified backend" degraded row (regex floor plus throttle) until a
//! qualification record lands, never a blanket 503.

use std::collections::BTreeMap;

use ryu_gw_screening::{CodeSet, QualificationRecord, RemoteMode, TaxonomyId};
use serde::Deserialize;
use serde_json::Value;

/// Backend ids the compiled baseline assigns when the floor carries no
/// `screener`: the local closed-choice decision model first (the primary
/// screener), then a guard model when one is configured. A remote processor
/// is never in the baseline.
pub const BASELINE_TEXT_BACKENDS: &[&str] = &["decision_local", "guard_text"];
/// The baseline prompt-attack backends.
pub const BASELINE_PROMPT_ATTACK_BACKENDS: &[&str] = &["decision_local", "inspector"];
/// The baseline vision backends (none exist on a fleet with no GPU).
pub const BASELINE_VISION_BACKENDS: &[&str] = &["guard_vision"];

/// What the floor does with a code once its score clears `block_threshold`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuleAction {
    Flag,
    Block,
}

/// One per-code rule.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HazardRule {
    pub action: RuleAction,
    pub block_threshold: f32,
    pub flag_threshold: f32,
    /// Hard codes block on a verdict and refuse or degrade without one.
    pub hard: bool,
}

/// The decision for one code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CodeAction {
    Allow,
    Flag,
    Block,
}

impl HazardRule {
    const fn block(block: f32, flag: f32, hard: bool) -> Self {
        Self {
            action: RuleAction::Block,
            block_threshold: block,
            flag_threshold: flag,
            hard,
        }
    }

    const fn flag(flag: f32) -> Self {
        Self {
            action: RuleAction::Flag,
            block_threshold: 1.0,
            flag_threshold: flag,
            hard: false,
        }
    }

    /// `score >= block_threshold ? base : score >= flag_threshold ? Flag : Allow`.
    pub fn decide(&self, score: f32, adult_permitted: bool) -> CodeAction {
        let base = match self.action {
            RuleAction::Block if !adult_permitted => CodeAction::Block,
            _ => CodeAction::Flag,
        };
        if self.action == RuleAction::Block && score >= self.block_threshold {
            base
        } else if score >= self.flag_threshold {
            CodeAction::Flag
        } else {
            CodeAction::Allow
        }
    }
}

/// The launch column of the spec 02.6.4 matrix: S4 and S9 block, S12 blocks
/// unless the model is adult-permitted, every other code flags.
pub fn default_rule(code: TaxonomyId) -> HazardRule {
    if code == TaxonomyId::S4 || code == TaxonomyId::S9 {
        HazardRule::block(0.5, 0.2, true)
    } else if code == TaxonomyId::S12 {
        HazardRule::block(0.7, 0.4, false)
    } else {
        HazardRule::flag(0.5)
    }
}

/// Surface deadlines (spec 02.7), in milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadlines {
    pub chat: u32,
    pub tool_round: u32,
    pub media: u32,
    pub batch: u32,
}

impl Default for Deadlines {
    fn default() -> Self {
        Self {
            chat: 600,
            tool_round: 400,
            media: 3000,
            batch: 30_000,
        }
    }
}

/// Backend ids per role, in order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Roles {
    pub text_hazard: Vec<String>,
    pub prompt_attack: Vec<String>,
    pub vision: Vec<String>,
    pub output: Vec<String>,
}

impl Roles {
    /// Every id any role names, deduplicated in first-seen order.
    pub fn all_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = Vec::new();
        for id in self
            .text_hazard
            .iter()
            .chain(&self.prompt_attack)
            .chain(&self.vision)
            .chain(&self.output)
        {
            if !ids.contains(&id.as_str()) {
                ids.push(id);
            }
        }
        ids
    }
}

/// An approved remote-processor record: a third party may see floor-bound
/// prompts through `backend_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteProcessorRecord {
    pub processor_id: String,
    pub backend_id: String,
    pub retention_days: u32,
    pub zdr: bool,
    pub dpa_ref: String,
    pub region: String,
    pub recorded_by: String,
    pub approved_by: String,
}

/// The validated `screener` field, or the compiled baseline.
#[derive(Debug, Clone, PartialEq)]
pub struct FloorScreener {
    /// Whether this came from the floor document (false: compiled baseline).
    pub explicit: bool,
    pub template_version: u32,
    pub remote_mode: RemoteMode,
    pub roles: Roles,
    /// Rules the floor sets; any other code takes [`default_rule`].
    pub hazards: BTreeMap<TaxonomyId, HazardRule>,
    pub adult_permitted_models: Vec<String>,
    pub deadlines: Deadlines,
    pub qualifications: Vec<QualificationRecord>,
    pub remote_processors: Vec<RemoteProcessorRecord>,
}

impl FloorScreener {
    /// The compiled baseline (no `screener` in the floor): the decision model
    /// and guard roles, no qualifications, no remote processor. It always
    /// lands in the section 6 "no qualified backend" row.
    pub fn baseline() -> Self {
        let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect();
        Self {
            explicit: false,
            template_version: 1,
            remote_mode: RemoteMode::Fallback,
            roles: Roles {
                text_hazard: ids(BASELINE_TEXT_BACKENDS),
                prompt_attack: ids(BASELINE_PROMPT_ATTACK_BACKENDS),
                vision: ids(BASELINE_VISION_BACKENDS),
                output: ids(BASELINE_TEXT_BACKENDS),
            },
            hazards: BTreeMap::new(),
            adult_permitted_models: Vec::new(),
            deadlines: Deadlines::default(),
            qualifications: Vec::new(),
            remote_processors: Vec::new(),
        }
    }

    /// The rule for `code`. S4 is forced to block, hard, at thresholds no
    /// looser than the default, whatever the document says.
    pub fn rule(&self, code: TaxonomyId) -> HazardRule {
        let base = default_rule(code);
        let mut rule = self.hazards.get(&code).copied().unwrap_or(base);
        if code == TaxonomyId::S4 {
            rule.action = RuleAction::Block;
            rule.hard = true;
            rule.block_threshold = rule.block_threshold.min(base.block_threshold);
            rule.flag_threshold = rule.flag_threshold.min(base.flag_threshold);
        }
        if code == TaxonomyId::S9 {
            rule.hard = true;
        }
        rule
    }

    /// Every hard code: S4, S9 and any code the floor marks `hard`.
    pub fn hard_codes(&self) -> CodeSet {
        let mut set = CodeSet::from([TaxonomyId::S4, TaxonomyId::S9]);
        for (code, rule) in &self.hazards {
            if rule.hard {
                set.insert(*code);
            }
        }
        set
    }

    /// Whether `model` may receive adult content (S12 then flags only).
    pub fn adult_permitted(&self, model: Option<&str>) -> bool {
        model.is_some_and(|model| {
            self.adult_permitted_models
                .iter()
                .any(|allowed| allowed == model)
        })
    }

    /// The remote-processor record for `backend_id` and `processor_id`.
    pub fn remote_record(&self, backend_id: &str, processor_id: &str) -> bool {
        self.remote_processors
            .iter()
            .any(|r| r.backend_id == backend_id && r.processor_id == processor_id)
    }

    /// Parse the wire `screener` object. `Err` names the first rule broken;
    /// the caller rejects the whole floor.
    pub fn parse(value: &Value) -> Result<Self, &'static str> {
        let wire: ScreenerWire =
            serde_json::from_value(value.clone()).map_err(|_| "malformed screener")?;
        let remote_mode = match wire.remote_mode.as_deref() {
            None | Some("fallback") => RemoteMode::Fallback,
            Some("parallel") => RemoteMode::Parallel,
            Some(_) => return Err("screener remoteMode is not fallback or parallel"),
        };
        let roles = Roles {
            text_hazard: role_ids(wire.roles.text_hazard)?,
            prompt_attack: role_ids(wire.roles.prompt_attack)?,
            vision: role_ids(wire.roles.vision)?,
            output: role_ids(wire.roles.output)?,
        };
        if roles.text_hazard.is_empty() {
            return Err("screener textHazard role is empty");
        }
        let mut hazards = BTreeMap::new();
        for (raw, rule) in wire.hazards {
            let code =
                TaxonomyId::parse(&raw).ok_or("screener hazard code is not in the taxonomy")?;
            let action = match rule.action.as_str() {
                "block" => RuleAction::Block,
                "flag" => RuleAction::Flag,
                _ => return Err("screener hazard action is not block or flag"),
            };
            if code == TaxonomyId::S4 && action != RuleAction::Block {
                return Err("hazard.S4 must block");
            }
            let flag = rule.flag_threshold;
            if !unit(flag) {
                return Err("screener flagThreshold is outside 0 to 1");
            }
            let block = match (action, rule.block_threshold) {
                (RuleAction::Block, Some(block)) if unit(block) && block >= flag => block,
                (RuleAction::Block, _) => return Err(
                    "screener blockThreshold is missing, outside 0 to 1, or below flagThreshold",
                ),
                (RuleAction::Flag, None) => 1.0,
                (RuleAction::Flag, Some(block)) if unit(block) => block,
                (RuleAction::Flag, Some(_)) => {
                    return Err("screener blockThreshold is outside 0 to 1")
                }
            };
            hazards.insert(
                code,
                HazardRule {
                    action,
                    block_threshold: block,
                    flag_threshold: flag,
                    hard: rule.hard,
                },
            );
        }
        let deadlines = match wire.deadlines_ms {
            None => Deadlines::default(),
            Some(d) => {
                let base = Deadlines::default();
                let pick = |value: Option<u32>, default: u32| match value {
                    Some(ms) if (1..=120_000).contains(&ms) => Ok(ms),
                    Some(_) => Err("screener deadline is outside 1 to 120000 ms"),
                    None => Ok(default),
                };
                Deadlines {
                    chat: pick(d.chat, base.chat)?,
                    tool_round: pick(d.tool_round, base.tool_round)?,
                    media: pick(d.media, base.media)?,
                    batch: pick(d.batch, base.batch)?,
                }
            }
        };
        let mut qualifications = Vec::new();
        for q in wire.qualifications {
            if q.backend_id.trim().is_empty()
                || q.model.trim().is_empty()
                || q.eval_ref.trim().is_empty()
            {
                return Err("screener qualification lacks a backend, model or evalRef");
            }
            let codes = q
                .codes
                .iter()
                .map(|raw| {
                    TaxonomyId::parse(raw)
                        .ok_or("screener qualification code is not in the taxonomy")
                })
                .collect::<Result<CodeSet, _>>()?;
            if codes.is_empty() {
                return Err("screener qualification names no code");
            }
            qualifications.push(QualificationRecord {
                backend_id: q.backend_id,
                model: q.model,
                weights_sha256: q.weights_sha256.map(|s| s.trim().to_ascii_lowercase()),
                template_version: q.template_version,
                codes,
            });
        }
        let mut remote_processors = Vec::new();
        for r in wire.remote_processors {
            let present = |s: &str| !s.trim().is_empty();
            if !present(&r.processor_id)
                || !present(&r.backend_id)
                || !present(&r.dpa_ref)
                || !present(&r.region)
                || !present(&r.recorded_by)
                || !present(&r.approved_by)
            {
                return Err("screener remote processor record is incomplete");
            }
            if r.recorded_by.trim() == r.approved_by.trim() {
                return Err("screener remote processor record lacks a second approver");
            }
            remote_processors.push(RemoteProcessorRecord {
                processor_id: r.processor_id,
                backend_id: r.backend_id,
                retention_days: r.retention_days,
                zdr: r.zdr,
                dpa_ref: r.dpa_ref,
                region: r.region,
                recorded_by: r.recorded_by,
                approved_by: r.approved_by,
            });
        }
        Ok(Self {
            explicit: true,
            template_version: wire.template_version,
            remote_mode,
            roles,
            hazards,
            adult_permitted_models: wire.adult_permitted_models,
            deadlines,
            qualifications,
            remote_processors,
        })
    }
}

fn unit(value: f32) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value) && value > 0.0
}

fn role_ids(ids: Vec<String>) -> Result<Vec<String>, &'static str> {
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.trim().to_owned();
        if id.is_empty() || out.contains(&id) {
            return Err("screener role names an empty or repeated backend id");
        }
        out.push(id);
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScreenerWire {
    template_version: u32,
    #[serde(default)]
    remote_mode: Option<String>,
    roles: RolesWire,
    #[serde(default)]
    hazards: BTreeMap<String, RuleWire>,
    #[serde(default)]
    adult_permitted_models: Vec<String>,
    #[serde(default)]
    deadlines_ms: Option<DeadlinesWire>,
    #[serde(default)]
    qualifications: Vec<QualificationWire>,
    #[serde(default)]
    remote_processors: Vec<RemoteProcessorWire>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RolesWire {
    text_hazard: Vec<String>,
    #[serde(default)]
    prompt_attack: Vec<String>,
    #[serde(default)]
    vision: Vec<String>,
    #[serde(default)]
    output: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuleWire {
    action: String,
    #[serde(default)]
    block_threshold: Option<f32>,
    flag_threshold: f32,
    #[serde(default)]
    hard: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeadlinesWire {
    #[serde(default)]
    chat: Option<u32>,
    #[serde(default)]
    tool_round: Option<u32>,
    #[serde(default)]
    media: Option<u32>,
    #[serde(default)]
    batch: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QualificationWire {
    backend_id: String,
    model: String,
    #[serde(default)]
    weights_sha256: Option<String>,
    template_version: u32,
    codes: Vec<String>,
    eval_ref: String,
    #[serde(default)]
    #[allow(dead_code)]
    recorded_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteProcessorWire {
    processor_id: String,
    backend_id: String,
    retention_days: u32,
    zdr: bool,
    dpa_ref: String,
    region: String,
    recorded_by: String,
    approved_by: String,
    #[serde(default)]
    #[allow(dead_code)]
    recorded_at: Option<String>,
}
