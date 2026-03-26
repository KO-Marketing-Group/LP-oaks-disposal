<?php
/**
 * Mailchimp subscribe proxy.
 * Called by the coming-soon signup forms; keeps the API key out of the browser.
 *
 * Required environment variables:
 *   MC_API_KEY  – Mailchimp API key
 *   MC_LIST_ID  – Audience / list ID
 *   MC_DC       – Data-center prefix (e.g. us14)
 *   MC_TAG      – Tag applied to new subscribers
 */

header('Content-Type: application/json');

/* ── Config from environment ─────────────────────────────────────── */
$mc_api_key = getenv('MC_API_KEY');
$mc_list_id = getenv('MC_LIST_ID');
$mc_dc      = getenv('MC_DC');
$mc_tag     = getenv('MC_TAG') ?: 'OaksDisposal';

if (!$mc_api_key || !$mc_list_id || !$mc_dc) {
    http_response_code(500);
    echo json_encode(['error' => 'Server configuration error.']);
    exit;
}

/* ── Validate request ───────────────────────────────────────────── */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$body  = json_decode(file_get_contents('php://input'), true);
$email = trim($body['email'] ?? '');

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['error' => 'Please enter a valid email address.']);
    exit;
}

/* ── Upsert subscriber (PUT is idempotent; handles new + returning) */
$hash    = md5(strtolower($email));
$api_url = sprintf(
    'https://%s.api.mailchimp.com/3.0/lists/%s/members/%s',
    $mc_dc, $mc_list_id, $hash
);

$payload = json_encode([
    'email_address' => $email,
    'status_if_new' => 'subscribed',
    'tags'          => [$mc_tag],
]);

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL            => $api_url,
    CURLOPT_CUSTOMREQUEST  => 'PUT',
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        'Authorization: Basic ' . base64_encode('anystring:' . $mc_api_key),
    ],
]);

$response = curl_exec($ch);
$status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$result = json_decode($response, true);

if ($status === 200) {
    echo json_encode(['success' => true]);
} else {
    http_response_code(400);
    $detail = $result['detail'] ?? 'Subscription failed. Please try again.';
    echo json_encode(['error' => $detail]);
}
