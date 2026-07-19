<?php
// Ivy chat proxy — keeps the Anthropic API key server-side so the public
// GitHub Pages app can offer "shared access" without exposing the key.
//
// Deploy: upload this file plus ivy-config.php (copy ivy-config.sample.php,
// fill in the real key and a passphrase) to any PHP host. Never commit
// ivy-config.php or put the key itself anywhere a browser can fetch.

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

// The passphrase gate: without it, anyone finding this URL could chat on the
// owner's credits. hash_equals avoids timing leaks.
if (!hash_equals((string) $config['passphrase'], (string) ($body['passphrase'] ?? ''))) {
  http_response_code(403);
  echo json_encode(['error' => ['message' => 'Wrong passphrase.']]);
  exit;
}

$allowedModels = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];
$model = in_array($body['model'] ?? '', $allowedModels, true) ? $body['model'] : 'claude-haiku-4-5';

if (!is_array($body['messages'] ?? null) || !is_array($body['system'] ?? null)) {
  http_response_code(400);
  echo json_encode(['error' => ['message' => 'Missing system or messages.']]);
  exit;
}

$payload = json_encode([
  'model' => $model,
  'max_tokens' => 1024,
  'system' => $body['system'],
  'messages' => $body['messages'],
]);

$ch = curl_init('https://api.anthropic.com/v1/messages');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => $payload,
  CURLOPT_HTTPHEADER => [
    'content-type: application/json',
    'x-api-key: ' . $config['api_key'],
    'anthropic-version: 2023-06-01',
  ],
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 120,
]);
$response = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($response === false) {
  http_response_code(502);
  echo json_encode(['error' => ['message' => 'Could not reach Anthropic.']]);
  exit;
}

http_response_code($status ?: 502);
echo $response;
