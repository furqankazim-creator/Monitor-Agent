# Email alerts and reports

Configure under **Integrations → Email** (stored encrypted) or via `SMTP_*` env vars.

## Amazon SES
1. Verify your sending domain/address in SES; request production access if still in sandbox.
2. Create SMTP credentials (SES console → SMTP settings). Host `email-smtp.<region>.amazonaws.com`, port **587** (STARTTLS) or **465** (tick *Implicit TLS*).
3. From address must be a verified identity, e.g. `Time Global Tech Monitor <alerts@yourdomain.com>`.
4. Save → **Send test**.

Any SMTP provider (SendGrid, Mailgun, Postmark, Google Workspace app password) works the same way.

## What is sent
* Incident, escalation and recovery emails (branded HTML + plain text) to recipients by project and level.
* Daily (after 06:00 UTC), weekly (Mondays) and monthly (1st) reports to recipients with those boxes ticked; each includes an HTML summary and a CSV attachment. Delivery is recorded per period so it is sent once.
* On-demand: Reports → *Email report…*.
