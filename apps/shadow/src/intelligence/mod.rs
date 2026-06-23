pub mod context;
pub mod delivery_manager;
pub mod embeddings;
pub mod grounding;
pub mod lora;
pub mod meeting;
pub mod model_manager;
pub mod proactive;
pub mod safety;
pub mod summary_queue;
pub mod transcription;
pub mod trust_tuner;

pub use context::{ContextSynthesizer, EpisodeStore};
pub use delivery_manager::{DeliveryDecision, DeliveryManager};
#[cfg(feature = "ort")]
pub use embeddings::CLIPEncoder;
pub use grounding::GroundingOracle;
pub use lora::{LoRATrainer, TrainingDataGenerator};
pub use meeting::{MeetingResolver, MeetingSummarizer, MeetingSummary, SummaryStore};
pub use model_manager::{ModelManager, CLIP_MODEL, SHOWUI_MODEL, WHISPER_TINY_MODEL};
pub use proactive::{ProactiveAnalyzer, ProactiveStore, ProactiveSuggestion};
pub use safety::SafetyGate;
pub use summary_queue::{CoordinatorResult, SummaryCoordinator, SummaryJob, SummaryQueue};
#[cfg(feature = "whisper-rs")]
pub use transcription::Transcriber;
pub use trust_tuner::{FeedbackKind, TrustParams, TrustTuner};
