# A02: source protection classification

The source client treats protection as a response-level condition, not as a
substring found anywhere in listing data.

## Classification order

1. `cf-mitigated: challenge` is the authoritative Cloudflare Challenge Page
   signal.
2. HTTP `429` is rate limiting and its `Retry-After` value is preserved.
3. HTTP `403` is access denial unless the response also has challenge evidence.
   Operationally it opens the same safe request circuit as a rate limit, but it
   uses the distinct `ACCESS_DENIED` transport classification and
   `http-403-access-denied` detector. It never requests manual CAPTCHA
   verification on status alone.
4. A successful JSON response is protection only when it is an error envelope
   (`error`, `errors`, `success: false`, or `ok: false`) with a rate-limit or
   challenge signal.
5. A successful HTML response requires document-level evidence in `title` or
   `h1`. An embedded CAPTCHA library or Cloudflare JavaScript Detection asset is
   not sufficient by itself.
6. Short `text/plain` error responses may use explicit protection language.

Consequently, listing IDs, mileage, prices, or descriptions containing `429`
do not trip rate limiting. A normal page that preloads reCAPTCHA, hCaptcha, or a
Cloudflare detection script does not trip challenge handling.

## References

- Cloudflare, "Detect a Challenge Page response":
  https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
- Cloudflare, "How Challenges work" (JavaScript Detection may be injected into
  normal HTML without interrupting the visitor):
  https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/
- RFC 6585 section 4, "429 Too Many Requests":
  https://www.rfc-editor.org/rfc/rfc6585#section-4
- RFC 9110 section 15.5.4, "403 Forbidden":
  https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.4

## Regression coverage

- real HTTP `429` plus `Retry-After`;
- authoritative Cloudflare response header;
- bare HTTP `403` classified as access denied, with the immediate OLX retry
  fenced by the local circuit;
- access-denied HTML document kept distinct from a challenge document;
- Cloudflare interstitial document fallback;
- real CAPTCHA document;
- structured JSON rate-limit error returned with HTTP 200;
- normal HTML containing mileage `429`, reCAPTCHA, and Cloudflare detection
  scripts;
- normal JSON data containing numeric ID `429`.
