Real Cloudflare Workers AI responses for @cf/cloudflare/clef, captured live on
2026-10-16 with the account id removed: ok.json (200), auth-401.json (a wrong
token) and named-criteria-422.json (a noul question with named criteria).

The two HTTP 429 bodies used by clef.test.ts (3036, the daily free allocation,
and 3040, out of capacity) could not be triggered cheaply; they follow the
codes and messages Cloudflare documents at
https://developers.cloudflare.com/workers-ai/platform/errors/ in the envelope
shape the captured errors above use.
