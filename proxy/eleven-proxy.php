<?php
// Ivy / Max voice proxy — keeps the ElevenLabs API key server-side so the
// public GitHub Pages app can use studio voices without every visitor bringing
// their own key.
//
// Deploy: upload this file next to ivy-proxy.php and ivy-config.php (copy
// ivy-config.sample.php, fill in the real keys and a passphrase). Never commit
// ivy-config.php or put a key anywhere a browser can fetch.

$config = require __DIR__ . '/ivy-config.php';

header('Access-Control-Allow-Origin: https://galasaf.github.io');
header('Access-Control-Allow-Headers: content-type');
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  echo json_encode(['error' => ['message' => 'POST only.']]);
  exit;
}

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
  http_response_code(400);
  echo json_encode(['error' => ['message' => 'Invalid request body.']]);
  exit;
}

// Passphrase gate: without it, anyone finding this URL could spend the owner's
// voice credits. hash_equals avoids timing leaks.
if (!hash_equals((string) $config['passphrase'], (string) ($body['passphrase'] ?? ''))) {
  http_response_code(403);
  echo json_encode(['error' => ['message' => 'Wrong passphrase.']]);
  exit;
}

if (empty($config['elevenlabs_key'])) {
  http_response_code(503);
  echo json_encode(['error' => ['message' => 'No ElevenLabs key configured.']]);
  exit;
}

// Sanitize inputs. Voice id is an ElevenLabs id (letters/digits); default Adam.
$voice = preg_replace('/[^A-Za-z0-9]/', '', (string) ($body['voice'] ?? ''));
if ($voice === '') {
  $voice = 'pNInz6obpgDQGcFmaJgB'; // Adam
}
$text = mb_substr((string) ($body['text'] ?? ''), 0, 1500);
if (trim($text) === '') {
  http_response_code(400);
  echo json_encode(['error' => ['message' => 'Nothing to say.']]);
  exit;
}

// Daily character budget shared across all users, so a busy day can never burn
// the whole monthly ElevenLabs quota. Tracked in a small JSON file next to this
// script; adjust the limit to taste. On 429 the app quietly uses a browser voice.
$dailyLimit = isset($config['voice_daily_chars']) ? (int) $config['voice_daily_chars'] : 8000;
$usageFile = __DIR__ . '/eleven-usage.json';
$today = gmdate('Y-m-d');
$fp = @fopen($usageFile, 'c+');
if ($fp) {
  flock($fp, LOCK_EX);
  $data = json_decode(stream_get_contents($fp), true);
  $used = (is_array($data) && ($data['date'] ?? '') === $today) ? (int) ($data['chars'] ?? 0) : 0;
  if ($used + mb_strlen($text) > $dailyLimit) {
    flock($fp, LOCK_UN);
    fclose($fp);
    http_response_code(429);
    echo json_encode(['error' => ['message' => 'Daily voice limit reached. Try again tomorrow.']]);
    exit;
  }
  $used += mb_strlen($text);
  ftruncate($fp, 0);
  rewind($fp);
  fwrite($fp, json_encode(['date' => $today, 'chars' => $used]));
  flock($fp, LOCK_UN);
  fclose($fp);
}

$payload = json_encode([
  'text' => $text,
  'model_id' => 'eleven_flash_v2_5',
  'voice_settings' => [
    'stability' => 0.35,
    'similarity_boost' => 0.8,
    'style' => 0.4,
  ],
]);

// with-timestamps returns JSON: base64 audio + per-character timing for lip-sync.
$url = 'https://api.elevenlabs.io/v1/text-to-speech/' . $voice
  . '/with-timestamps?output_format=mp3_44100_64';

$ch = curl_init($url);
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => $payload,
  CURLOPT_HTTPHEADER => [
    'content-type: application/json',
    'xi-api-key: ' . $config['elevenlabs_key'],
  ],
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 120,
]);
$response = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($response === false) {
  http_response_code(502);
  echo json_encode(['error' => ['message' => 'Could not reach ElevenLabs.']]);
  exit;
}

// Pass the ElevenLabs response straight through (audio_base64 + alignment).
http_response_code($status ?: 502);
echo $response;
