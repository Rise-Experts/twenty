# Architecture v2 Amendment

Amends all six plans in this directory. Written 2026-08-07 after eight new requirements.

Read this before executing any of the existing plans. Where it contradicts them, this document wins.

---

## The requirements, and what the codebase actually allows

| # | Requirement | Verdict |
|---|---|---|
| 1 | One shared Leads table across every app, each contributing 1-2 columns | **Supported.** `defineField()` cross-app extension |
| 2 | Lead app searches by **radius**, not text location | **Supported.** Places `locationRestriction.circle`. Plan change needed |
| 3 | ~~Social apps support OAuth **and** a directly pasted access token~~ | **Withdrawn 2026-08-07.** OAuth only |
| 4 | Social apps pull company/page information | Supported |
| 5 | Every social platform exposed as AI tools | Supported. `toolTriggerSettings` |
| 6 | A tool that posts an uploaded PDF or media URL | Supported, but **only LinkedIn takes a PDF natively** |
| 7 | ~~Per-workspace OAuth credentials~~ | **Withdrawn 2026-08-07.** One app registration, users OAuth into it |
| 8 | ~~Per-workspace callback URL derived from workspace name~~ | **Withdrawn 2026-08-07.** Follows from 7 |
| 9 | Connections usable **workspace-wide or per user** | **Supported natively.** `visibility: 'user' \| 'workspace'` |

Requirements 3, 7, and 8 were withdrawn after establishing that requirement 9 — the thing actually wanted — is built in. See the decision note below.

---

## Finding 1: the built-in connection provider cannot do per-workspace credentials

`connection-provider.service.ts:44` resolves OAuth client credentials from `applicationRegistrationVariableRepository`, keyed by `applicationRegistrationId`. That is **instance-wide**. Every workspace on the server shares one client id and secret.

`connection-provider-oauth-flow.service.ts:118` builds the redirect as `buildAppOAuthCallbackUrl(this.getServerUrl())`, and `getServerUrl()` is `twentyConfigService.get('SERVER_URL')` — one URL for the whole instance. The workspace is carried in a signed `state` JWT instead, not in the URL.

`ConnectionProviderType` is `'oauth'` and nothing else. The type's own comment lists `'apiKey'` and `'pat'` as *anticipated* future values. There is no path today for a pasted token.

So `defineConnectionProvider` gives one credential set and one callback URL per instance. That is the opposite of requirements 3, 7, and 8.

### What does work

`applicationVariable` is **workspace-scoped**. It extends `SyncableEntity` → `WorkspaceRelatedEntity`, and the unique index is `['workspaceId', 'universalIdentifier']`. Better still, the entity carries a check constraint:

```sql
CHK_applicationVariable_value_encrypted:  "value" = '' OR "value" LIKE 'enc:v2:%'
```

with the comment *"All values are always encrypted regardless of `isSecret`. The `isSecret` flag only controls display behavior."* So per-workspace secrets are encrypted at rest whether or not you mark them secret.

And `httpRouteTriggerSettings` **resolves the workspace from the request host**. That is exactly requirement 8: `https://acme.crm.example.com/s/social/oauth/meta/callback` and `https://beta.crm.example.com/s/social/oauth/meta/callback` hit the same function and resolve to different workspaces, with no extra configuration.

### Decision, 2026-08-07: keep `defineConnectionProvider`

This app is being built for distribution — a workspace installs it, configures OAuth, and its members connect accounts either workspace-wide or individually. Pasted-token mode is dropped. **OAuth only.**

Against that goal the built-in provider wins, because it already delivers the workspace-wide-plus-per-user requirement natively and the hand-rolled flow would have to reimplement it.

`listConnections` in the SDK, and the `appConnections` query behind it, expose exactly this:

```ts
export type ListConnectionsFilter = {
  providerName?: string;
  userWorkspaceId?: string;
  visibility?: 'user' | 'workspace';
};
```

and each connection carries `visibility`, `userWorkspaceId`, `accessToken`, `scopes`, and `authFailedAt`. The visibility is chosen at connect time and signed into the OAuth `state`.

What comes free, and would otherwise be four re-implementations:

| Capability | Where |
|---|---|
| Workspace-wide vs per-user connections | `visibility` on the connection, chosen at connect time |
| Token storage | Connection rows, encrypted |
| Automatic token refresh | `refresh/services/app-oauth-refresh-tokens.service.ts` |
| Revocation on disconnect | `refresh/services/app-oauth-revoke.service.ts` |
| PKCE | `usePkce` on the oauth config |
| CSRF-safe state | Signed JWT carrying workspace, user, and visibility |
| Broken-connection surfacing | `authFailedAt` |

### Where the credentials live, concretely

Not in `.env`, and not in the server environment. They are declared in the manifest, entered through the UI, and stored encrypted in Postgres.

```
1. declare        defineApplication({ serverVariables: {
                    META_APP_ID:     { isSecret: false },
                    META_APP_SECRET: { isSecret: true  },
                  }})

2. reference      defineConnectionProvider({ oauthConfig: {
                    clientIdVariable:     'META_APP_ID',
                    clientSecretVariable: 'META_APP_SECRET',
                  }})

3. deploy         yarn twenty apply
                    -> syncVariableSchemas() creates empty, required rows in
                       core.applicationRegistrationVariable

4. admin fills    Settings > Admin Panel > Apps > Social
                    (or the app registration's Config tab)
                    -> stored in encryptedValue, encrypted at rest

5. consumed       connection-provider.service.ts getClientCredentials()
                    decrypts them when a user clicks Connect.
                    Also injected into logic functions as process.env.*
```

Step 4 is the only manual step, and it is done once per instance by whoever administers it.

### The one callback URL to register

`buildAppOAuthCallbackUrl` resolves to `{SERVER_URL}/auth/apps/callback`. Its source comment states the intent plainly:

> *Workspace-agnostic by design: the workspace identity travels in the signed `state` parameter, so a single redirect URL configured at the OAuth provider serves every workspace.*

For the current instance that is:

```
https://crm.riseexperts.de/auth/apps/callback
```

Register that one URL with Meta, LinkedIn, and TikTok. It serves every workspace on the instance and never needs adding to again.

### Why the per-workspace-credentials requirement should be dropped

It is not just that it costs 600 lines. For a distributable app it is actively worse for your users.

If each workspace brings its own Meta app, **each workspace has to complete Meta App Review itself** — Business Verification plus advanced permissions, two to six weeks of work, per customer, before they can post once. No social tool ships that onboarding.

The standard model, and what Buffer, Hootsuite, and Zapier all do, is the opposite: the app author registers one platform app, completes App Review once, and every user just clicks "Connect Facebook." That is precisely what `defineConnectionProvider` implements.

And the instance-wide scope of the credentials is not a real constraint in either distribution shape:

- **Self-hosted, distributed to other self-hosters.** Each instance has its own admin, who fills in the registration variables. Per-instance is per-customer. Correct by construction.
- **One instance you operate, many customer workspaces.** You register one Meta app, pass App Review once, and every workspace's members OAuth into it. Correct, and the only sane onboarding.

The single case it does not cover is several *unrelated* tenants sharing one instance who each insist on their own Meta app. If that case ever arrives, revisit — the hand-rolled flow sketched in git history for this document still applies.

### What the plans keep

`defineConnectionProvider` and `serverVariables` stay in all four platform plans, exactly as originally written. Requirements 3, 7, and 8 are withdrawn. The only addition is visibility handling:

```ts
// in each platform's account-discovery function
const connections = await listConnections({
  providerName: 'meta',
  // Workspace-wide accounts are usable by everyone; per-user
  // connections stay bound to the member who authorised them.
});

for (const connection of connections) {
  const accounts = await discoverAccounts(connection.accessToken);

  for (const account of accounts) {
    await upsertSocialAccount({
      ...account,
      visibility: connection.visibility,
      ownerUserWorkspaceId: connection.visibility === 'user'
        ? connection.userWorkspaceId
        : null,
    });
  }
}
```

`SocialAccount` therefore gains two fields in social-core Task 2:

- `visibility` — SELECT `WORKSPACE` / `USER`
- `ownerUserWorkspaceId` — TEXT, null for workspace-wide accounts

and `buildTargetsForPost` in Task 5 gains a filter so a per-user account only receives posts from its owner.

---

## Finding 1b: what is actually on crm.riseexperts.de

Inspected live on 2026-08-07 through the metadata API.

Deployed version is **v2.27.0**. Record counts are 5 people, 5 companies, 6 opportunities.

**There is no Lead object.** The workspace has 28 objects, every one owned by the standard Twenty application (`eca70b35-024e-451e-a66d-00d7c03b4d17`). That list is byte-identical to `STANDARD_OBJECTS` in this checkout, and neither contains a `lead` entry. No custom objects exist.

**But four apps are installed, contributing 35 fields to standard objects.** They were invisible in the first pass because `applicationId` was checked on objects rather than on fields.

| App | Version | Fields | Notes |
|---|---|---|---|
| **Standard** | 1.0.1 | 438 | Twenty's built-in objects. Not uninstallable |
| **Custom** | 1.0.1 | 2 | **Twenty's container for hand-made custom fields**, not a third-party app. Holds `company.source` and `workspaceMember.territory`. Not uninstallable |
| **Last contact** | 1.2.3 | 20 | Public app, source in `packages/twenty-apps/public/last-contact` |
| **Call Recorder** | 1.7.1 | 5 | Public app, source in `packages/twenty-apps/public/call-recorder` |
| **Lead Scoring Agent** | 0.1.0 | 8 | *"AI lead scoring and enrichment agent for Twenty CRM."* **Not in this repo** |

### The Lead Scoring Agent, in detail

It owns **no objects**. It is pure `defineField()` extension plus event-driven logic — precisely the architecture Finding 2 proposes, already running in production here.

```
agent            leadScorer  "Scores B2B leads (people and opportunities)
                              from 0 to 100 based on fit and buying signals."

logic functions  scoreOnPersonCreated        databaseEvent, inline or queued if imported
                 scoreOnPersonUpdated        databaseEvent, on scoring-relevant fields
                 scoreOnOpportunityCreated   databaseEvent
                 scoreOnOpportunityUpdated   databaseEvent
                 drainQueue                  cron, capped batch of QUEUED leads
                 backfill                    idempotent enqueue of unscored records

variables        none
```

It adds, to **person and opportunity**:

| Field | Type |
|---|---|
| `leadScore` | NUMBER |
| `leadScoreStatus` | SELECT `QUEUED` / `SCORED` / `SKIPPED` / `FAILED` |
| `leadScoreSummary` | TEXT |
| `leadScoredAt` | DATE_TIME |

These do **not** exist anywhere in this checkout — `grep -rn "leadScore" packages/` returns nothing. They come entirely from that installed app.

Four consequences:

1. **The shared-table architecture in Finding 2 is already proven on this instance.** Three apps extend standard objects through `defineField()` right now, one of them with database-event triggers and a drain cron. Not a theoretical pattern.
2. **`company.source` and `workspaceMember.territory` are hand-made custom fields**, held by Twenty's built-in "Custom" pseudo-application. No third party owns them and nothing can uninstall them. An earlier draft of this document warned they could vanish with an app; that was wrong. They are still worth superseding with a `source` field owned by `twenty-leads-core`, but only for clarity, not for safety.
3. **The Lead Scoring Agent scores `person` and `opportunity`, and nothing else.** A new `Lead` object gets no scoring from it. Do not treat that as a problem — it is the right seam. See below.
4. **Find out where the Lead Scoring Agent came from** before extending it. It is version 0.1.0 and not in this repo, so it is private or from the marketplace. If you own the source, teaching it about `Lead` is a small change. If you do not, leave it alone.

### How the two fit together

The scoring app's `scoreOnPersonCreated` fires on every new Person, and it queues rather than scoring inline for bulk imports. That makes the pipeline compose without any coordination between the apps:

```
discovery / social forms
        ▼
    Lead  (raw, unqualified, GDPR-purgeable)
        ▼  promote, after review
 Person + Company + Opportunity(stage NEW)
        ▼  scoreOnPersonCreated fires automatically
   leadScore, leadScoreStatus, leadScoreSummary
```

`twenty-leads-core` therefore owns **discovery, dedupe, provenance, suppression, and promotion**. The Lead Scoring Agent owns **qualification after promotion**. Neither needs to know the other exists, and the handoff is a plain Person insert.

### One collision the promotion step must avoid

Five workflows exist on the instance. Three are noise — a user-made `Temp` and two unnamed drafts. Two are **seeded standard workflows**, both ACTIVE, both defined in `prefill-workflows.util.ts`:

| Workflow | Trigger | Relevance |
|---|---|---|
| Quick Lead | MANUAL → a form step | Demo starter. Harmless |
| **Create company when adding a new person** | `person.upserted` on the `emails` field | **Fires on every promotion** |

The second one matters. Its filter, `buildPersonSyncSourceFilter`, suppresses only `createdBy.source` of `EMAIL` and `CALENDAR`. Its own unit test asserts it **runs** for `API`, `IMPORT`, `WORKFLOW`, `SYSTEM`, `WEBHOOK`, and `MANUAL`, and that it fails open when the source is missing. A Person created by a logic function is `API`, so this workflow fires on every single lead promotion.

Its steps are a find-or-create chain, not a blind insert:

```
Is this a personal email?   CODE
If business email           FILTER
Extract domain from email   CODE
Search Company              FIND_RECORDS  company.domainName CONTAINS domain
Find exact company match    CODE
                            → link or create
```

So it will not duplicate a company it can find. **The promotion function must therefore create the Company first, then create the Person with `companyId` already set.** Do it in the other order and the workflow races the promotion, finds nothing, and creates a second Company.

Two smaller notes on the same workflow: it skips personal-email domains entirely, so a gmail.com lead never gets a Company from it, and its domain match is `CONTAINS`, which is loose enough to mis-link short domains. Both are arguments for `twenty-leads-core` owning the company match itself and setting `companyId` explicitly rather than relying on the seeded workflow.

This also resolves the separate-object-versus-extend-Person question from below in favour of a separate object: extending Person would make every scraped business immediately scoreable, which floods the scoring queue with unqualified records and burns AI credits on businesses nobody has looked at.

Also already present and worth reusing:

- `opportunity.stage` is `NEW` / `SCREENING` / `MEETING` / `PROPOSAL` / `CUSTOMER`, so the pipeline already begins at a lead-like stage.

Standard object universal identifiers, needed for every `defineField()` extension:

```
person       20202020-e674-48e5-a542-72570eee7213
company      20202020-b374-4779-a561-80086cb2e17f
opportunity  20202020-9549-49dd-b2b2-883999db8938
```

### Separate Lead object, or extend Person and Company?

Given scoring already exists, extending Person is tempting. Keep the separate `Lead` object anyway, for three reasons that are about data hygiene rather than modelling taste:

1. **Unverified data must not enter the source of truth.** Places results and social form submissions are unqualified. Writing them straight into Person and Company contaminates the CRM permanently, and there is no clean way to unwind it later.
2. **Dedupe rules differ.** Person dedupes on email. A discovered business often has a domain and no email at all.
3. **Retention differs, and this one is legally load-bearing.** Under GDPR you want to purge unconverted leads on a schedule without touching customer records. That is trivial with a separate table and painful with a `isLead` flag on Person.

Two adjustments to the shared `Lead` object so it lines up with what is already there:

- Reuse the exact field names `leadScore`, `leadScoreStatus`, `leadScoreSummary`, `leadScoredAt`, and reuse the `QUEUED` / `SCORED` / `SKIPPED` / `FAILED` option set. Twenty's scoring feature and its UI conventions then apply unchanged.
- Promotion writes `Lead` → `Person` + `Company` + an `Opportunity` at `stage: NEW`, and copies provenance into the existing `company.source`. No new fields on the standard objects are needed for the happy path.

---

## Finding 2: one Leads table, many contributors

`defineField()` with `objectUniversalIdentifier` adds a column to an object owned by another app, and Twenty puts it in the same physical table. That is exactly requirement 1.

This needs an owner for the shared object, so the app topology changes:

```
twenty-leads-core          NEW. Owns Lead, LeadSuppression, LeadActivity.
   │                       Owns promotion to Person/Company.
   │                       Every other app depends on it.
   ├── twenty-lead-discovery      +3 columns: placeId, searchRadiusMeters, discoveredAt
   ├── twenty-social-core         +2 columns: sourcePlatform, sourceAccountId
   │      ├── twenty-social-facebook   +2: fbLeadgenId, fbFormId
   │      ├── twenty-social-instagram  +1: igMediaId
   │      ├── twenty-social-linkedin   +1: liLeadFormId
   │      └── twenty-social-tiktok     +1: ttLeadId
```

Seven apps. The install order is a hard dependency: `twenty-leads-core` first, or every `defineField` fails to resolve its target.

The shared `Lead` object moves out of `2026-08-07-lead-discovery-app.md` Task 2 into the new core app, unchanged in shape. Add these to it, since every source now needs them:

```ts
// on the shared Lead object in twenty-leads-core
{
  name: 'sourceKind',
  type: FieldType.SELECT,
  options: [
    { value: 'SEARCH', label: 'Search', position: 0, color: 'blue' },
    { value: 'SOCIAL_FORM', label: 'Social form', position: 1, color: 'purple' },
    { value: 'SOCIAL_ENGAGEMENT', label: 'Social engagement', position: 2, color: 'purple' },
    { value: 'MANUAL', label: 'Manual', position: 3, color: 'gray' },
  ],
},
{
  name: 'externalId',
  type: FieldType.TEXT,
  description: 'Provider record id. Combined with sourceProvider this is the dedupe key for non-web leads.',
},
```

**Dedupe changes.** The lead-discovery plan deduped on `domain`. A social form lead often has an email and no domain. The rule becomes, in order:

1. `sourceProvider` + `externalId` both match → same record, skip
2. `domain` matches and is non-null → same business, skip
3. `emails.primaryEmail` matches → same person, skip
4. Otherwise, insert

That is one function, `findDuplicateLead(client, candidate)`, in `twenty-leads-core`. It replaces `findExistingLeadDomains` from lead-discovery Task 8, and every app calls it.

---

## Finding 3: radius search

Lead discovery currently expands criteria into `"{category} in {location}"` text queries. Requirement 2 wants a radius. Places supports it properly:

```ts
{
  textQuery: 'dentist',
  locationRestriction: {
    circle: {
      center: { latitude: 48.1351, longitude: 11.5820 },
      radius: 5000,          // metres, 0.0 to 50000.0
    },
  },
  pageSize: 20,
}
```

`LeadSearchCriteria` changes:

```ts
export type LeadSearchCriteria = {
  categories: string[];
  keywords: string[];
  // Replaces `locations: string[]`
  centers: { label: string; latitude: number; longitude: number }[];
  radiusMeters: number;        // 1 to 50000, the Places ceiling
  requireWebsite: boolean;
  languageCode: string;
  regionCode: string;
  maxPagesPerQuery: number;
};
```

`expandCriteriaToQueries` produces `categories × centers`, each carrying the circle. Everything downstream is unchanged.

**The 60-result cap now bites harder.** One circle returns at most 60 businesses regardless of radius, so a 50 km circle over Munich silently truncates. The honest pattern is many small circles, not one big one. Add a helper and use it in the criteria builder:

```ts
// twenty-lead-discovery/src/lib/criteria/tile-circle.ts

// Places caps any single query at 60 results. A wide circle therefore
// under-reports without saying so. Tiling into overlapping smaller
// circles trades API cost for actual coverage.
export const tileCircle = ({
  center,
  radiusMeters,
  tileRadiusMeters,
}: {
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  tileRadiusMeters: number;
}): { latitude: number; longitude: number }[] => { /* hex packing */ };
```

Log the tile count when a search runs. A user asking for 50 km and getting 37 queries should be able to see why their bill moved.

---

## Finding 4: the media matrix, and PDFs

Requirement 6 asks for a tool taking the URL of an uploaded PDF or media. What each platform actually accepts differs enough that a single "post this file" tool would lie:

| Platform | Image | Video | **PDF** | How |
|---|---|---|---|---|
| Facebook Page | Yes | Yes | **No** | Post as a link with a preview |
| Instagram | JPEG only | MP4/MOV as Reels | **No** | Not possible. Render page 1 to an image |
| LinkedIn | Yes | Yes | **Yes, natively** | Documents API → `urn:li:document:` |
| TikTok | Photo post | MP4/MOV/WEBM | **No** | Not possible |

**Only LinkedIn posts a PDF as a document.** It renders as a swipeable carousel, which is the single best organic format on that platform, so this is worth building properly rather than working around.

The `SocialPublisher` contract gains one field so the core validator can enforce this before any API call:

```ts
// amends src/lib/publish/publisher.type.ts in social-core Task 4
export type MediaKind = 'image' | 'video' | 'document';

export type SocialPublisher = {
  platform: SocialPlatform;
  maxBodyLength: number;
  requiresMedia: boolean;
  supportedMedia: MediaKind[];   // NEW
  publish(input: PublishInput): Promise<PublishResult>;
};
```

Values: Facebook `['image', 'video']`, Instagram `['image', 'video']`, LinkedIn `['image', 'video', 'document']`, TikTok `['video']`, dry run all three.

`validatePostForTarget` gains a check that classifies each media URL by extension and rejects unsupported kinds with a message naming the platform. A PDF fanned out to all four then produces one `PUBLISHED` on LinkedIn and three `FAILED` targets each saying `FACEBOOK does not support document media`, which is the truthful outcome and exactly what per-target status exists for.

Twenty's own `FILES` field type and attachment storage give you the public URL to feed these APIs. Instagram and TikTok fetch server-side, so the URL must be public https, and for TikTok on a domain verified with them.

---

## Finding 5: tools on every platform

Requirement 5. Each social app adds `toolTriggerSettings` to its publish path, so agents and MCP clients can drive it. Declare the schema once and reuse it for the workflow action, per the SDK docs:

```ts
// e.g. twenty-social-facebook/src/logic-functions/post-to-facebook.logic-function.ts
const inputSchema: InputJsonSchema = {
  type: 'object',
  properties: {
    socialAccountId: { type: 'string', label: 'Facebook Page', description: 'SocialAccount record id' },
    body: { type: 'string', label: 'Post text' },
    mediaUrl: { type: 'string', label: 'Media URL', description: 'Public https image or video URL. Facebook does not accept PDFs.' },
    scheduledAt: { type: 'string', label: 'Schedule for', description: 'ISO 8601. Omit to publish now.' },
  },
  required: ['socialAccountId', 'body'],
};

export default defineLogicFunction({
  // ...
  description:
    'Publishes a post to a connected Facebook Page. Accepts an image or video URL. '
    + 'Does NOT accept PDFs — use post_to_linkedin for documents. '
    + 'Use when the user asks to post, share, or announce something on Facebook.',
  toolTriggerSettings: { inputSchema },
  workflowActionTriggerSettings: {
    label: 'Post to Facebook',
    icon: 'IconBrandFacebook',
    inputSchema: jsonSchemaToInputSchema(inputSchema),
    outputSchema: [{ type: 'object', properties: { socialPostId: { type: 'string' } } }],
  },
});
```

Per-platform tool names: `post_to_facebook`, `post_to_instagram`, `post_to_linkedin`, `post_to_tiktok`, plus `post_to_all_platforms` in social-core. Write the descriptions carefully — the media limitations belong in the description, because that is the only place an agent will read them.

`twenty-leads-core` also exposes `search_leads`, `promote_lead`, and `suppress_lead`.

Requirement 4, company information, becomes one more tool per platform: `get_facebook_page_info` and friends, reading follower counts and profile metadata onto the `SocialAccount` record.

---

## Per-plan deltas

Nothing below is optional. Apply it before executing that plan.

### New: `twenty-leads-core`
Does not exist yet. Owns `Lead`, `LeadSuppression`, `LeadActivity`, `findDuplicateLead`, promotion, and the three lead tools. **Must be written and installed first.**

### `2026-08-07-lead-discovery-app.md`
- **Task 2 deleted.** `Lead` moves to `twenty-leads-core`. Replace with three `defineField()` extensions.
- **Task 4 rewritten.** `centers` + `radiusMeters` replace `locations`; add `tileCircle`.
- **Task 6 changed.** `searchPlacesPage` sends `locationRestriction.circle`.
- **Task 8 replaced.** `findDuplicateLead` from the core supersedes `findExistingLeadDomains`.

### `2026-08-07-social-core.md`
- **Task 4 amended.** `supportedMedia` added to `SocialPublisher`.
- **Task 5 amended.** `validatePostForTarget` classifies media and enforces `supportedMedia`.
- **New task.** `applicationVariables` scaffolding, the shared OAuth start/callback route pair, and the state-nonce store.
- **New task.** `post_to_all_platforms` tool.
- **New task.** Two `defineField()` extensions on the shared `Lead`.

### All four platform plans
- **Task 1 stands as written.** `defineConnectionProvider` and `serverVariables` stay. No hand-rolled OAuth.
- **The `onConnect` / `onDisconnect` hooks stand as written**, with one addition: the discovery loop reads `connection.visibility` and `connection.userWorkspaceId` and carries them onto each `SocialAccount` it creates.
- **Each adds** `supportedMedia`, a `post_to_{platform}` tool, a `get_{platform}_info` tool, and its 1-2 `defineField()` columns on the shared `Lead`.
- **LinkedIn additionally** implements the Documents API upload so PDFs work. This is the only platform where that is possible and it is the most valuable single addition in the set.

---

## What this costs

Less than the first draft of this document assumed. Withdrawing requirements 3, 7, and 8 removes roughly 600 lines of hand-rolled OAuth across the four platform plans and hands token storage, refresh, revocation, PKCE, and CSRF protection back to Twenty.

What remains to add, over and above the six plans as originally written:

| Change | Where | Rough size |
|---|---|---|
| `twenty-leads-core` app | new | ~8 tasks |
| Radius search and circle tiling | lead-discovery Tasks 4 and 6 | ~150 lines |
| `findDuplicateLead` replacing domain-only dedupe | leads-core, used everywhere | ~80 lines |
| `supportedMedia` and media classification | social-core Tasks 4 and 5 | ~60 lines |
| `visibility` and `ownerUserWorkspaceId` on SocialAccount, plus fan-out filter | social-core Tasks 2 and 5 | ~50 lines |
| Two tools per platform | four platform plans | ~80 lines each |
| LinkedIn Documents API for PDF | linkedin plan | ~150 lines |

The single highest-value item in that list is the LinkedIn Documents API. It is the only way any of the four platforms takes a PDF natively, and PDF carousels are the strongest organic format LinkedIn has.
