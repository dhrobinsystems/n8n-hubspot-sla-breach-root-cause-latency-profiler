# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-hubspot-sla-breach-root-cause-latency-profiler**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. That includes inaccurate, incomplete or late SLA reports; wrongly attributed root causes; operational, staffing, vendor or performance decisions made on the basis of an automated latency analysis; lead or timing data disclosed to the wrong channel or audience; and incorrectly written or overwritten HubSpot records.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, formulas and sample payloads are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Latency figures are only as accurate as the timestamps your forms, ingest pipeline, enrichment provider, routing rules and dialer write to HubSpot. Nothing here guarantees that those timestamps are complete, synchronised or semantically consistent, or that HubSpot, Slack or Microsoft Teams APIs and payload formats will stay unchanged.

**Not an Individual Performance Tool:** Hop latencies and owner breakdowns are operational diagnostics for process bottlenecks. They are not a sufficient basis for disciplinary or compensation decisions about individuals without human review of the underlying records and circumstances.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox and a private test Slack or Teams channel, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot credentials or set `NOTIFICATIONS_ENABLED=true` or `HUBSPOT_MUTATIONS_ENABLED=true`. Treat every SLA report and root-cause attribution as a draft that a person must review before it's relied on or shared further.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), employment and works-council rules, and security policies of HubSpot, Slack, Microsoft, n8n, and any connected services. That includes confirming a lawful basis for processing lead timing data, keeping personal data out of notifications (this workflow references leads by record ID only), limiting owner-level metrics to the audience entitled to see them, posting only to private channels, treating webhook URLs as secrets, and reviewing every automatically posted message and updated record.

The full disclaimer is also available in [DISCLAIMER.md](DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 DH Robin (dhRobin Systems) · Provided as-is, see the disclaimer.
