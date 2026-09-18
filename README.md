# whatsapp-coding-agent — Phase 1

A standalone Next.js TypeScript App Router service for Meta WhatsApp Cloud API, deployed to Vercel. This phase only receives text instructions and replies `Received task: <their message>`. No AI agent, GitHub integration, branches, commits, pull requests, approvals, or merge operations exist here.

## Architecture and files

- `app/api/whatsapp/webhook/route.ts`: App Router entry point and scheduling replies after the HTTP response using Next.js `after`.
- `lib/webhook.ts`: GET verification and POST handling with an injectable scheduler for testing.
- `lib/config.ts`: validated environment configuration, restricted to the server.
- `lib/whatsapp.ts`: signature verification, defensive parsing, outbound Cloud API requests, and task acknowledgements.
- `types/whatsapp.ts`: normalized inbound message and outbound payload types.
- `app/layout.tsx`, `app/page.tsx`: minimal service landing page and layout.
- `tests/whatsapp.test.ts`: verification, signatures, parsing, status acknowledgements, and mocked outgoing reply checks.
- `.env.example`: configuration template without credentials.
- `package.json`, `package-lock.json`, `tsconfig.json`, `next-env.d.ts`, `next.config.ts`, `eslint.config.mjs`, `.gitignore`: app/tooling setup.

Inbound webhook data is treated as unknown until checked. Only nonempty text messages for the configured phone-number ID are processed. Images, audio, statuses, other objects, and malformed entries are ignored. Duplicate message IDs within one delivery are ignored. Sending text is separate from the webhook transport so a future task service can replace the acknowledgement without changing Cloud API handling.

## Local setup

Use Node.js 22.13+ or 24 and npm. This is a separate project: run commands from this directory, not from the portfolio root.

```sh
npm install
cp .env.example .env.local
npm run dev -- --port 3002
```

Fill `.env.local` with your own credentials:

| Variable | Value |
| --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | A random string you choose; use the exact same string in Meta webhook configuration. Generate one with `openssl rand -hex 32`. |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp Cloud API access token from your Meta app API Setup page; use a suitable system-user token for ongoing use. |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta's numeric **Phone number ID**, not the visible phone number or WhatsApp Business Account ID. |
| `WHATSAPP_APP_SECRET` | Your Meta app's **App secret**, under App settings → Basic; required to validate signed POST requests. |
| `WHATSAPP_API_VERSION` | A supported Graph API version shown in your Meta dashboard/API documentation (example: `v25.0`). |

Never put these values in client code, use `NEXT_PUBLIC_` variables, commit `.env.local`, or paste tokens in logs. The sender number and message text are intentionally logged per Phase 1 requirements; restrict access to Vercel logs because these are personal data.

Run verification:

```sh
npm run lint
npm test
npm run build
```

Tests mock outgoing calls; they do not send live WhatsApp messages.

## Configure Meta WhatsApp Cloud API

1. Sign in at https://developers.facebook.com/apps/ and create/select an app configured for the WhatsApp Business Platform. Choose the WhatsApp use case/product and associate the required business portfolio when prompted.
2. Open WhatsApp → API Setup (or the equivalent setup page for your app). Meta provides a test business number, its **Phone number ID**, and a temporary access token. Copy the ID/token into the service environment. Do not use LinkedIn credentials from your portfolio.
3. Add your personal WhatsApp number as an allowed test recipient and verify it using Meta's code. Use the dashboard's sample/test message to confirm the business test number can reach you.
4. From App settings → Basic, copy the **App secret** into `WHATSAPP_APP_SECRET`. Choose a random `WHATSAPP_VERIFY_TOKEN`. Set the API version to a supported version from the dashboard.
5. Deploy this separate app to Vercel following the next section. The webhook must be reachable over public HTTPS; localhost alone will not work. For local testing, use a secure HTTPS tunnel forwarding to port 3002 and put its HTTPS URL in Meta instead.
6. In WhatsApp → Configuration → Webhooks, enter the callback URL below and your chosen verify token. Select **Verify and save**. Meta calls GET with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`; the service returns the challenge as plain text.
7. Subscribe the WhatsApp Business Account webhook to the **messages** field. Make sure the app is subscribed to the same WhatsApp Business Account containing your configured number; if using a manually provisioned account, check its `subscribed_apps` association. A verified callback by itself does not subscribe message events.
8. From your verified personal WhatsApp number, send `Fix the hero image on my portfolio mobile view.` to the business/test number (reply to its test conversation). Expect `Received task: Fix the hero image on my portfolio mobile view.` back.
9. Check Vercel runtime logs for the sender/text and any send failures. Status webhooks should receive 200 and never trigger another reply, avoiding reply loops.
10. Before using a real business number, complete Meta's phone registration/business requirements for your account and replace the temporary token with an appropriately authorized system-user token assigned to the WhatsApp assets. Sending requires `whatsapp_business_messaging`; management operations may require `whatsapp_business_management`. Access for other businesses may require additional Meta review. User-initiated messages open the customer-service window for these text replies; outside that window approved templates are required.

Official references: [Cloud API setup](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started), [Meta's Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [Meta webhook verification reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/). Dashboard labels may differ by app use case.

## Deploy to Vercel

Create a **separate Vercel project**, not a deployment over `mayanksomani.in`. Import this service's own repository if you create one. If deploying a repository containing this directory, set **Root Directory** to `whatsapp-coding-agent`; this workspace currently excludes the service from the portfolio's Git tracking, so it must first be stored in its own repository or deployed from this directory using Vercel CLI. Creating/pushing a service repository is not part of this phase.

Choose Next.js and Node.js 22/24. Add all five environment variables in Settings → Environment Variables for Production (and Preview if needed). Deploy/redeploy after changing variables. Ensure the callback URL has no Vercel deployment-protection login challenge: Meta needs public access. Prefer a stable production URL for the webhook, not a changing preview URL.

**Webhook URL to enter in Meta after deployment:**

```text
https://YOUR-VERCEL-PROJECT.vercel.app/api/whatsapp/webhook
```

If Vercel assigns `whatsapp-coding-agent.vercel.app`, the URL is:

```text
https://whatsapp-coding-agent.vercel.app/api/whatsapp/webhook
```

The exact domain is determined by Vercel; no deployment has been created by this scaffold.

## Responses and delivery limitations

- GET valid verification: **200** with the exact challenge. Invalid verification: **403**. Missing server configuration: **503**.
- POST authentic, valid JSON: **200** `{ "received": true }`, including ignored events. Invalid/missing signature: **401**. Invalid JSON: **400**. Missing/invalid configuration: **503**, allowing retry once configuration is fixed.
- Replies run using `after` after returning 200, with an 8-second timeout per outgoing request and a 60-second function budget. Outbound failures are logged with message ID and safe HTTP status, never tokens/raw provider responses. Long replies are split at 4096 characters.
- Phase 1 acknowledges receipt, not guaranteed delivery. There is no durable queue or outgoing retry, and no durable cross-delivery deduplication. Meta may independently redeliver events; repeated deliveries can send repeated acknowledgements. A server restart/function timeout can lose pending reply work. For production automation, add durable event storage, message-ID deduplication, and a worker queue before accepting coding jobs. In-memory state would not solve this on Vercel.

## Phase 1 acceptance check

Webhook verification succeeds, a real incoming text is logged, the expected reply arrives on your phone, unsupported/status events return 200 without replies, and no secret appears in browser assets. Lint/build and mocked tests verify code locally; the real Meta/Vercel acceptance check needs your account configuration and is not yet completed.

Future phases must keep every coding task on its own branch, never push directly to main/master, open a PR with a Vercel preview, and merge only after authenticated explicit `APPROVE <task-id>`. Those features are deliberately not implemented in Phase 1.
