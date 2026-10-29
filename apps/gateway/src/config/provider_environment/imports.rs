//! Restores operator-authored provider slots whose environment import is closed.
use super::*;

pub(super) fn restore_closed_imports(
    effective: &mut ProvidersConfig,
    authored: &ProvidersConfig,
) -> Result<(), String> {
    for (id, allowed) in &authored.environment_imports {
        macro_rules! connection {
            ($field:ident) => {
                if !allowed {
                    effective.$field = authored.$field.clone();
                }
            };
        }
        match id.as_str() {
            "openai" => connection!(openai),
            "anthropic" => connection!(anthropic),
            "openrouter" => connection!(openrouter),
            "litellm" => connection!(litellm),
            "modal" => connection!(modal),
            "cohere" => connection!(cohere),
            "deepgram" => connection!(deepgram),
            "assemblyai" => connection!(assemblyai),
            "elevenlabs" => connection!(elevenlabs),
            "inworld" => connection!(inworld),
            "replicate" => connection!(replicate),
            "fal" => connection!(fal),
            "recraft" => connection!(recraft),
            "stability" => connection!(stability),
            "bfl" => connection!(bfl),
            "minimax" => connection!(minimax),
            "runway" => connection!(runway),
            "topaz" => connection!(topaz),
            "cloudflare" => connection!(cloudflare),
            "bedrock" => connection!(bedrock),
            "vertex" => connection!(vertex),
            "openai-credits" => connection!(openai_credits),
            "anthropic-credits" => connection!(anthropic_credits),
            direct if ryu_gw_credentials::direct_compatible_provider_url(direct).is_some() => {
                if !allowed {
                    match authored.compatible.get(direct) {
                        Some(entry) => {
                            effective
                                .compatible
                                .insert(direct.to_owned(), entry.clone());
                        }
                        None => {
                            effective.compatible.remove(direct);
                        }
                    }
                }
            }
            _ => return Err("Unknown native provider environment-import scope".to_owned()),
        }
    }
    Ok(())
}
