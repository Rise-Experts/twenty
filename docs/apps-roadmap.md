# Twenty Apps Roadmap

Planning document for four apps on self-hosted Twenty. Written 2026-08-06.

Everything here is grounded in what is actually in this repo at commit `0bf4b53af3`. File paths are real and clickable.

---

## 0. Executive summary

Four ideas were proposed. After reading the codebase, they are not four equal-sized projects:

| # | Idea | Reality | Effort |
|---|------|---------|--------|
| 4 | Gmail / Calendar / Outlook | **Already built in core.** Needs OAuth configuration, not development. | Days |
| 3 | AI using Twenty MCP | Agent framework and MCP server already exist. You build tools and agents. | 2-3 weeks |
| 1 | Lead discovery via search | Real build. Two existing apps are close templates. Legally constrained in Germany. | 4-6 weeks |
| 2 | Social media (Meta, LinkedIn, TikTok) | Largest build. Blocked on platform approvals that take weeks to months. | 8-12 weeks + approval time |

**Two decisions that matter more than anything else in this document:**

1. **Build these as apps, not as forks of core.** Twenty ships an application platform (`packages/twenty-sdk`, `packages/twenty-cli`). Apps are versioned, publishable, and survive upstream upgrades. Every line you add to `packages/twenty-server` is a line you merge-conflict on at every Twenty release.

2. **Start the social platform approval applications this week**, even though app 2 is built last. Meta Business Verification, LinkedIn partner access, and TikTok audits are the long pole. They run in parallel with everything else at zero cost.

---

## 1. The platform you are building on

Verified primitives in `packages/twenty-sdk/src/sdk/define/`:

| Primitive | Purpose |
|---|---|
| `defineApplication` | App manifest, metadata, `serverVariables` for secrets |
| `defineObject` / `defineField` / `defineIndex` | Custom objects and fields, real Postgres columns |
| `defineLogicFunction` | Server-side function, six trigger types (below) |
| `defineConnectionProvider` | Generic OAuth2 to third parties, with `onConnect` / `onDisconnect` hooks |
| `defineAgent` | AI agent with prompt, response format, and a role |
| `defineSkill` | Reusable agent skill |
| `defineView` / `definePageLayout` / `defineFrontComponent` | UI |
| `defineRole` / `definePermissionFlag` | Access control |
| `defineNavigationMenuItem` / `defineCommandMenuItem` | Navigation |

### Logic function triggers

From `packages/twenty-shared/src/application/logicFunctionManifestType.ts`:

- `cronTriggerSettings` — scheduled execution
- `databaseEventTriggerSettings` — react to record create/update/delete
- `httpRouteTriggerSettings` — **public HTTP endpoint, this is how you receive platform webhooks**
- `serverRouteTriggerSettings` — authenticated server route
- `toolTriggerSettings` — expose the function as an AI tool with a JSON schema
- `workflowActionTriggerSettings` — usable as a step in Twenty workflows

A single function can carry several. The Exa app's search function is both an AI tool and callable directly.

### Connection providers

`defineConnectionProvider` supports generic OAuth2: authorization endpoint, token endpoint, revoke endpoint, scopes, PKCE, and client credentials pulled from server variables. Connections have `visibility: 'user' | 'workspace'`.

This covers Meta, LinkedIn, and TikTok without touching core. Confirmed in `packages/twenty-shared/src/application/oauthConnectionProviderConfigType.ts`.

### Apps already in the repo, worth reading before you write anything

| Path | Why it matters |
|---|---|
| `packages/twenty-apps/public/exa` | Smallest complete app. Web search as an AI tool. **Read this first.** |
| `packages/twenty-apps/public/people-data-labs` | Contact/company enrichment, bulk workflow, record mapping. Closest template to app 1. |
| `packages/twenty-apps/public/slack` | OAuth connection provider + webhooks |
| `packages/twenty-apps/public/linear` | Two-way external sync |
| `packages/twenty-apps/examples/hello-world` | Scaffolding reference |

Scaffold with `npx create-twenty-app my-app`, publish with `npx twenty app:publish --private`.

---

## 2. App 4: Gmail, Calendar, Outlook

### This is already built

| Capability | Where it lives |
|---|---|
| Gmail sync | `packages/twenty-server/src/modules/messaging/message-import-manager/drivers/gmail` |
| Outlook / Microsoft 365 mail | `.../message-import-manager/drivers/microsoft` |
| Generic IMAP / SMTP | `.../drivers/imap`, `.../drivers/smtp` |
| Inbound email | `.../drivers/inbound-email` |
| Google Calendar read | `modules/calendar/calendar-event-import-manager/drivers/google-calendar` |
| Google Calendar write | `modules/calendar/calendar-event-creation-manager/drivers/google-calendar` |
| Microsoft Calendar read | `.../calendar-event-import-manager/drivers/microsoft-calendar` |
| Microsoft Calendar write | `.../calendar-event-creation-manager/drivers/microsoft-calendar` |
| IMAP/SMTP/CalDAV config | `engine/core-modules/imap-smtp-caldav-connection` |
| OAuth token storage + refresh | `modules/connected-account/refresh-tokens-manager` |
| Contact auto-creation from participants | `modules/contact-creation-manager`, `modules/match-participant` |
| Outbound send | `modules/messaging/message-outbound-manager` |
| Folder sync, blocklist, timeline | `message-folder-manager`, `modules/blocklist`, `modules/timeline` |

The OAuth strategies are all AGPL, not enterprise-gated: `google.auth.strategy.ts`, `microsoft.auth.strategy.ts`, and the `*-apis-oauth-*` strategies in `engine/core-modules/auth/strategies/`.

### What you actually have to do

**Google:**
1. Create a Google Cloud project, enable Gmail API and Google Calendar API
2. Configure the OAuth consent screen. Gmail scopes are restricted, so publishing externally requires Google's security assessment. **For an internal workspace, set the consent screen to Internal and skip the assessment entirely.** This is the single biggest time-saver.
3. Create OAuth client credentials, set the redirect URI to your instance
4. Set `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GOOGLE_CALLBACK_URL`, plus the APIS variants for sync
5. Enable the messaging and calendar feature flags on the workspace

**Microsoft:**
1. Register an app in Microsoft Entra ID
2. Add Graph delegated permissions: `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`, `offline_access`
3. Grant admin consent for your tenant
4. Set `AUTH_MICROSOFT_*` variables

**Then run the worker.** Sync is cron-driven through BullMQ. Without `npx nx run twenty-server:worker` nothing syncs.

### Gaps worth building later, once you have used it

None of these are in core:

- **Email sequencing / cadences** — multi-step follow-up with reply detection and auto-stop
- **Meeting booking links** — a public scheduling page backed by calendar availability
- **Shared team inbox** — assignment, internal notes, SLA
- **Merge-field email templates** — `packages/twenty-emails` is transactional only

Use the product for a week before deciding. My expectation is sequencing is the one you actually want, and it pairs naturally with app 1.

### Recommendation

Do the configuration first, this week. It is the highest value-per-hour item on the list by a wide margin, and it gives you a populated CRM to build the other three apps against.

---

## 3. App 3: AI agents over MCP

### What already exists

**Agent framework** — `packages/twenty-server/src/engine/metadata-modules/ai/`:
`ai-agent`, `ai-agent-execution`, `ai-agent-monitor`, `ai-agent-role`, `ai-chat`, `ai-models`, `ai-billing`, `ai-generate-text`, `ai-workspace-stats`

**MCP server** — `packages/twenty-server/src/engine/api/mcp/`:
- `controllers/mcp-core.controller.ts` — JSON-RPC over HTTP with SSE
- `services/mcp-tool-executor.service.ts` — tool dispatch
- `guards/mcp-auth.guard.ts` — API key auth
- `tools/list-skills.tool.ts`, `tools/list-object-metadata-names.tool.ts`
- `utils/build-mcp-server-instructions.util.ts` — dynamic instructions from your schema

Because the MCP surface is generated from object metadata, your custom objects become MCP tools automatically. Same trick as the GraphQL and REST APIs.

### Three different things "AI with MCP" could mean

**(a) Point external AI clients at your Twenty.** Claude Desktop or Claude Code connects to your MCP endpoint with an API key and can query and modify CRM data. This is configuration, roughly an afternoon. **Do this first**, it will teach you what tools are missing.

**(b) Build in-Twenty agents with custom tools.** `defineAgent` plus logic functions carrying `toolTriggerSettings`. This is the actual app.

**(c) Build an external AI service that talks to Twenty over MCP.** Only worth it if you need orchestration Twenty's agent runtime cannot express. Decide after (a) and (b).

### Proposed build for (b)

**Agents:**

| Agent | Job |
|---|---|
| SDR Agent | Qualify inbound leads, draft first-touch messages, propose next actions |
| Research Agent | Given a company, gather context from web search and enrich the record |
| Inbox Triage Agent | Read synced email, classify, link to records, flag what needs a human |

**Tools** (logic functions with `toolTriggerSettings`, following the `exa-web-search.ts` pattern):

- `search_web` — reuse the Exa app, do not rebuild
- `enrich_company` / `enrich_person` — reuse People Data Labs, or your own provider
- `draft_email` — templated draft against a record, returns text, never sends
- `summarize_thread` — condense a message thread onto the record timeline
- `propose_next_action` — writes a Task, does not act autonomously

**Two design rules that matter:**

1. **Give every agent a role.** `defineAgent` accepts `roleUniversalIdentifier`. Agent actions then run under Twenty's normal permission system rather than as an unbounded superuser. This is the single most important safety property, and it is free.

2. **Agents propose, humans dispose.** Have agents write Tasks and drafts rather than sending email or mutating records directly. Revisit once you trust the outputs.

**Cost control:** use `chargeCredits` from `twenty-sdk/billing` (see the Exa app for the pattern) so per-agent spend is visible in `ai-billing` rather than discovered on a monthly invoice.

### Effort

2-3 weeks. No external approvals, no legal review, small surface. This is the best second project.

---

## 4. App 1: Lead discovery through search

### The core problem with the original framing

Scraping Google search results is against Google's Terms of Service, gets IP-blocked quickly, and breaks whenever the page markup changes. It is also the weakest source. Do not build this.

There are better legitimate sources, and two are already apps in your repo.

### Sources, ranked

| Source | Returns | Cost | Notes |
|---|---|---|---|
| **Google Places API (New)** | Business name, address, phone, website, category, hours, rating | ~$32/1000 Text Search | The real "find businesses near X in industry Y" API. No email addresses. |
| **Website Impressum crawl** | Email, phone, legal entity, managing director | Your compute | **German businesses are legally required to publish this** (DDG §5, formerly TMG §5). Highest-quality, lowest-risk source for the German market. |
| **Exa** | Semantic web search with a `company` category | ~$0.007/search | Already an app: `packages/twenty-apps/public/exa` |
| **People Data Labs** | Company and person enrichment | Per-record | Already an app: `packages/twenty-apps/public/people-data-labs` |
| **Google Custom Search JSON API** | SERP results, legitimately | 100/day free, then $5/1000, 10k/day cap | Legal alternative to scraping |
| **Dropcontact** | Email discovery, GDPR-native | Per-record | French, built for EU compliance. Worth evaluating over Hunter/Apollo given your market. |

The Impressum route deserves emphasis. For German B2B it produces better data than any paid aggregator, from a source the business is legally obliged to publish, on their own website. Combine Places API for discovery with Impressum crawl for contact details and you have a strong pipeline with a defensible legal story.

### Architecture

**Objects:**

```
LeadSearch          Saved dynamic criteria. The thing a business "sets".
  ├─ name, isActive, schedule
  ├─ criteria (JSON)
  └─ sources (which adapters to run)

LeadSearchRun       One execution.
  ├─ startedAt, finishedAt, status
  ├─ resultCount, newCount, duplicateCount
  └─ costMicroCredits

Lead                A discovered prospect, before promotion to Company/Person.
  ├─ business fields
  └─ provenance fields (see compliance below)
```

Keep `Lead` separate from `Company` and `Person`. Promotion should be an explicit reviewed step. Writing unverified scraped data straight into your CRM contaminates it permanently.

**Dynamic criteria** — stored as JSON on `LeadSearch`, which is what makes it configurable per business:

```ts
{
  industry: string[],          // Places category or free text
  location: { center, radiusMeters } | { country, region },
  companySize?: { min, max },
  keywords: string[],
  excludeKeywords: string[],
  requireWebsite: boolean,
  requireEmail: boolean,
  excludeExistingCustomers: boolean,
  maxResultsPerRun: number,
}
```

**Logic functions:**

| Function | Triggers | Job |
|---|---|---|
| `lead-search-run` | cron, tool, workflowAction | Orchestrates one run of a saved search |
| `source-google-places` | (internal) | Places adapter |
| `source-exa` | (internal) | Exa adapter |
| `enrich-impressum` | (internal) | Fetch and parse a German Impressum page |
| `lead-dedupe-upsert` | (internal) | Match on domain, then name+postcode, then fuzzy |
| `lead-promote` | tool, workflowAction | Lead → Company + Person, after review |

**Front component:** criteria builder, plus a results review queue with bulk approve/reject.

**Agent tie-in:** expose `lead-search-run` and `lead-promote` as tools so the Research Agent from app 3 can run searches conversationally.

### Compliance: read this before writing code

You are a German company. This is the part that determines whether the app is an asset or a liability.

**What is personal data.** `info@firma.de` and a company's registered address are generally not personal data. `max.mueller@firma.de`, a named managing director, and a direct dial are. GDPR applies to the second group even in a B2B context.

**Legal basis.** Legitimate interest, Art. 6(1)(f). This requires a documented Legitimate Interest Assessment before you start processing, not after a complaint. Write it once, keep it on file.

**Art. 14 notice.** When you collect personal data from somewhere other than the person, you must tell them: who you are, what you hold, why, and their rights. Due within one month, or at first contact if that is sooner. In practice this means your first email includes the notice. Build it into the template.

**Germany is stricter than the rest of the EU on outreach.** UWG §7(2) treats unsolicited email advertising as an unreasonable nuisance **without prior consent, including B2B**. There is no soft opt-in for cold prospects. Cold calling B2B requires at least presumed consent. Practical consequences:

- Cold email to German prospects carries real Abmahnung risk. Competitors and law firms actively pursue this.
- Safer routes: LinkedIn outreach, phone under presumed consent, postal mail, or inbound-triggered contact.
- Get your own legal sign-off. This document is engineering guidance, not legal advice.

**Required provenance fields on `Lead`:**

```
sourceProvider          which adapter produced it
sourceUrl               the exact page
collectedAt             timestamp
legalBasis              enum
lia Reference           link to your assessment
art14NoticeSentAt       when the notice went out
optedOutAt              suppression timestamp
suppressionReason
```

Build the suppression list on day one, not after the first complaint. A lead that opted out must never be re-added by a later run, which means the dedupe function checks suppression before insert.

**Google Places ToS:** most Places content may not be cached beyond 30 days; `place_id` is the exception and may be stored indefinitely. Design storage around this. Store `place_id` permanently, refresh the rest.

**robots.txt:** honor it on the Impressum crawler. Rate-limit to something polite, identify yourself in the user agent.

### Effort

4-6 weeks of build. The legal groundwork can run in parallel and should start first, because if cold email to German prospects is ruled out, the app's design changes: it becomes a research and qualification tool feeding manual outreach, which is a smaller and different build.

---

## 5. App 2: Social media

### Honest platform assessment

This is where ambition meets platform bureaucracy. The build is tractable. The access is not.

**Meta (Facebook + Instagram)** — best of the four.
- Publishing to Pages and Instagram Business accounts is well supported and stable
- **Lead Ads with the `leadgen` webhook is the highest-value piece in this entire document.** A user submits an instant form in-feed, the webhook fires, the lead lands in Twenty within seconds
- Requires: Business Verification, App Review for `pages_manage_posts`, `instagram_content_publish`, `leads_retrieval`, and `ads_management` if you want ad control
- Instagram publishing needs an IG Business or Creator account linked to a Facebook Page. Limit is 100 API-published posts per 24h per account
- Long-lived **Page** tokens do not expire. The 60-day lifetime applies to the **user** token they are derived from, so no refresh cron is needed for publishing
- Realistic timeline to approval: 2-6 weeks

**TikTok** — workable, more friction.
- Content Posting API supports direct post, and requires an audit
- Business API covers ads and Lead Generation instant forms
- Requires an approved developer app and a TikTok Business account
- Realistic timeline: 4-8 weeks

**LinkedIn** — hardest by a large margin. Plan for it to not happen.
- Personal posting via `w_member_social` is obtainable
- **Company page posting needs Community Management API access, which is partner-gated**
- **Lead Gen Forms need `r_marketing_leadgen_automation`, also partner-gated**
- There is no legitimate API for automating personal profile activity, connection requests, or scraping. LinkedIn enforces this aggressively, including litigation and permanent bans
- Applications are frequently rejected without a stated reason
- Realistic timeline: 2-6 months, outcome uncertain

**Plan LinkedIn as manual-with-assist**: the app drafts the post and tracks it, a human publishes. Upgrade to API if partner access is ever granted. Do not let LinkedIn block the rest of the app.

### Architecture

**Connection providers** (`defineConnectionProvider`, generic OAuth2 handles all of these):

```
meta        Facebook Pages + Instagram Business
tiktok      Content Posting + Business
linkedin    member scope initially, organization scope if approved
```

Client IDs and secrets go in `serverVariables` on the app manifest, as `isSecret: true`.

**Objects:**

```
SocialAccount       A connected page/profile. Platform, handle, token expiry.
SocialPost          Canonical content. Body, media, scheduledAt, status.
SocialPostTarget    Per-channel fan-out. One row per platform per post.
                    Holds platform post id, status, error, published time.
SocialMetric        Time-series engagement per target.
SocialCampaign      Groups posts and ties spend to results.
LeadFormSubmission  Raw inbound lead payload before mapping.
```

`SocialPostTarget` as a separate object is the important call. One post to four platforms fails partially all the time. Modeling per-target status is the difference between a usable tool and a mystery.

**Logic functions:**

| Function | Trigger | Job |
|---|---|---|
| `webhook-meta-leadgen` | httpRoute | Receive Meta lead ads, verify signature, create `LeadFormSubmission` |
| `webhook-tiktok-leads` | httpRoute | Same for TikTok |
| `publish-post` | cron, workflowAction, tool | Fan out a due `SocialPost` to its targets |
| `refresh-social-tokens` | cron | Refresh tokens before the 60-day expiry |
| `pull-metrics` | cron | Engagement and ad spend |
| `map-lead-submission` | databaseEvent | `LeadFormSubmission` → Person + Company + Task |

Signature verification on the webhooks is not optional. These are public endpoints. Meta signs with `X-Hub-Signature-256`.

**Front component:** composer with per-platform character limits and previews, a calendar view of scheduled posts, and a per-target status panel.

### Effort

8-12 weeks of build, plus approval time that runs concurrently if you start now.

Suggested internal phasing:
1. Connection providers and `SocialAccount` (works before any approval, using dev-mode apps against your own test pages)
2. Meta publishing
3. Meta Lead Ads webhook — **highest ROI, prioritize over publishing if you have to choose**
4. Metrics
5. TikTok
6. LinkedIn, manual-assist mode

---

## 6. Recommended sequence

```
Week 1        App 4 configuration. Google + Microsoft OAuth, worker running.
              ALSO: submit Meta Business Verification, TikTok developer app,
              LinkedIn partner application. Zero cost, long lead time.
              ALSO: start the Legitimate Interest Assessment for app 1.

Weeks 2-4     App 3. MCP endpoint for external clients, then agents and tools.
              Small, self-contained, teaches you the SDK.

Weeks 5-10    App 1. Lead discovery. Design is contingent on the legal
              outcome from week 1, so that answer needs to land by week 4.

Weeks 8-20    App 2. Social. Starts when the first platform approval lands,
              overlaps app 1. Meta first, LinkedIn last or never.
```

The two things to do this week are the app 4 configuration and the three approval applications. Neither requires writing code, and the approvals gate everything in app 2.

---

## 7. Cross-cutting concerns

**Keep it in apps.** Every app above is achievable with `defineObject`, `defineLogicFunction`, `defineConnectionProvider`, `defineAgent`, and `defineFrontComponent`. If you find yourself editing `packages/twenty-server`, stop and reconsider. Upstream moves fast and merge pain compounds.

**Secrets.** Use `serverVariables` with `isSecret: true` in the application manifest, injected into logic function execution. Never commit credentials. See the Exa app's `EXA_API_KEY` declaration.

**Cost visibility.** Places API, Exa, PDL, and LLM tokens all bill per call. Use `chargeCredits` consistently so spend shows up in `ai-billing` per app and per operation.

**Rate limits.** Every external API here is limited. Use the SDK job queue (`twenty-sdk/logic-function/jobs`) rather than looping inside a single function. Logic functions have execution timeouts.

**Testing.** The Exa and PDL apps both ship unit tests and integration tests. Copy the structure; these apps are mostly integration glue and that is exactly where untested code fails.

**Idempotency.** Webhooks redeliver and crons overlap. Every ingest path needs a natural key and an upsert, not an insert.

---

## 8. Open questions

1. **Target market for app 1.** Germany only, DACH, or wider? This changes the compliance posture significantly.
2. **Outreach channel.** Given UWG §7, is cold email actually viable for you, or does app 1 feed manual and phone outreach? Determines the design.
3. **Budget for data providers.** Places, Exa, PDL, and Dropcontact are all per-call. A rough monthly ceiling shapes source selection.
4. **Existing accounts.** Do you already have a Meta Business Manager, a LinkedIn Company Page, and a TikTok Business account? Verification is faster with established accounts.
5. **Volume.** Leads per month and posts per week. Changes queueing and rate-limit design.
6. **Users.** How many people in the workspace, and do they need different access to lead data? Relevant to the role design on each app.
