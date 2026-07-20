<?php
// Copy to ivy-config.php next to ivy-proxy.php and fill in real values.
// NEVER commit ivy-config.php — it holds the actual API key.
return [
  'api_key' => 'sk-ant-your-real-key-here',        // Anthropic (chat) — used by ivy-proxy.php
  'elevenlabs_key' => 'sk_your-elevenlabs-key-here', // ElevenLabs (voice) — used by eleven-proxy.php
  'passphrase' => 'choose-a-passphrase-for-family',
];
