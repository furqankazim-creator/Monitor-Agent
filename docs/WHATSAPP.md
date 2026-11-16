# WhatsApp alerts (Meta WhatsApp Business Cloud API)

Only the official Cloud API is used – no unofficial automation or browser scraping.

## Setup
1. Meta Business Manager → create a **Business app** → add the **WhatsApp** product → note the **Phone Number ID** and WhatsApp Business Account.
2. Create a **System User** and generate a **permanent access token** with `whatsapp_business_messaging` permission.
3. **Create and get approved a message template** (category *Utility*), e.g. name `monitor_alert`, body with six variables:
   ```
   TIME GLOBAL TECH MONITOR
   {{1}}
   Asset: {{2}}
   Project: {{3}}
   Issue: {{4}}
   Incident: {{5}}
   Dashboard: {{6}}
   ```
   Variables are filled in this order: title, asset, project, issue, incident ID, secure link.
4. In the app: **Integrations → WhatsApp**: Phone Number ID, access token, app secret, verify token, template name + language → Save → **Send test**.
5. Webhook (delivery receipts): in Meta set callback URL `https://<your-host>/api/webhooks/whatsapp`, the same verify token, subscribe to `messages`. Requests are accepted only with a valid `X-Hub-Signature-256` (needs the **app secret**).
6. **Alerts → Add recipient** → channel WhatsApp, number in international digits, confirm opt-in.

## Policy notes
* Business-initiated messages **outside the 24-hour customer-service window must use an approved template.** If no template is configured the platform sends free-text, which Meta will reject outside that window – configure a template for production.
* Recipients must have opted in; the UI/API refuse WhatsApp recipients without recorded consent.
* Delivery state is tracked (`sent → delivered → read`, or `failed` with Meta's reason) and shown in the incident timeline and Alerts → Delivery log. Transient failures retry with back-off (10 s, 30 s, 2 min, 10 min, 30 min, 1 h); permanent 4xx errors fail immediately and visibly. A failed notification never resolves or hides an incident.
* Until configured, alerts are stored as `unconfigured` and are sent automatically once you save credentials.
