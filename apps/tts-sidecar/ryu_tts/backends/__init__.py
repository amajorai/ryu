"""TTS backend implementations.

Each module here defines one class implementing `ryu_tts.registry.TtsBackend`
and is referenced from a row in `ryu_tts.registry.ENGINES`. Modules import their
heavy inference dependencies *inside* methods (not at module top level) so a
missing optional dep degrades that single engine, never the whole server.
"""
