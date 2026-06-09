/**
 * redactFallback.ts — Pure JS PII redaction, used when the native iOS module
 * (NSDataDetector-backed) isn't available (Android, web, tests). Mirrors the
 * server-side `redactPII` in ai_layer/pipelines/embedding/embedding_client.ts.
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// 9–15 digits with up to 2 separator chars between them (covers "+1 (415) 555-0199");
// the 9-digit floor keeps dates (8 digits) and amounts out of scope.
const PHONE_RE = /\+?(?:\d[\s\-().]{0,2}){8,14}\d/g;

export function redactPIIFallback(text: string): string {
  if (!text) return text;
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
}
