# Lead Discovery App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Twenty app that turns saved, dynamic search criteria into deduplicated business leads in the CRM, sourced from the Google Places API with full provenance tracking.

**Architecture:** A standalone Twenty app (not a core fork) built with `twenty-sdk`. Four custom objects hold criteria, run history, leads, and a suppression list. Source adapters and mapping logic are pure TypeScript modules with unit tests. Orchestration uses the documented chunked-chain pattern: a cron scheduler enqueues runs, and a page function processes one Places page per invocation and enqueues its own successor until the query matrix is exhausted.

**Tech Stack:** TypeScript, `twenty-sdk` 2.23+, `twenty-client-sdk`, Vitest 4, oxlint, Google Places API (New).

## Global Constraints

- Node `^24.5.0`, Yarn 4 via Corepack, Docker for the local dev server.
- `twenty-sdk` and `twenty-client-sdk` go in `devDependencies`. Only true runtime imports go in `dependencies`.
- Every `universalIdentifier` is a UUID v4, generated once, never changed. Changing one destroys and recreates the entity.
- Literal string `defaultValue`s must carry inner quotes: `"'NEW'"`, not `"NEW"`.
- No secret is ever committed. `GOOGLE_MAPS_API_KEY` is declared as a `serverVariable` and filled in by an admin through **Settings → Admin Panel → Apps**. See "How the API key is configured" below.
- Every lead write records provenance: `sourceProvider`, `sourceExternalId`, `sourceUrl`, `collectedAt`, `legalBasis`.
- Handlers reached by `enqueueJob` with `retryLimit > 0` must be idempotent.
- Google Places caps Text Search at **20 results per page and 60 total per query**. Volume comes from expanding criteria into many narrow queries, never from paging one broad query.
- Google Places ToS: only `places.id` may be cached indefinitely. Treat every other Places field as refreshable, not archival.

**Out of scope for this plan** (each gets its own plan later): the Impressum crawler, the Exa source adapter, the front-end criteria builder, promotion of Leads into Company/Person, and any outreach or email sending.

---

## File Structure

```text
twenty-lead-discovery/
  src/
    application-config.ts                  App identity + GOOGLE_MAPS_API_KEY server variable
    roles/lead-discovery.role.ts           Least-privilege role for the logic functions
    constants/universal-identifiers.ts     All UUIDs in one place
    objects/
      lead.object.ts                       The discovered prospect
      lead-search.object.ts                Saved dynamic criteria
      lead-search-run.object.ts            One execution
      lead-suppression.object.ts           Opt-out list
    fields/                                Bidirectional relation field pairs
    lib/
      criteria/
        criteria.type.ts                   LeadSearchCriteria + PlacesQuery types
        expand-criteria-to-queries.ts      Criteria -> query matrix
      sources/google-places/
        google-places.type.ts              Wire types for the Places response
        google-places-client.ts            HTTP client, one page per call
        map-place-to-lead.ts               Place -> Lead input, with provenance
        parse-phone.ts                     International number -> Twenty PHONES shape
      dedupe/
        normalize-domain.ts                Canonical dedupe key
        lead-lookup.ts                     Existing-lead and suppression checks
    logic-functions/
      lead-search-scheduler.logic-function.ts   Cron, fans out to runs
      lead-search-run.logic-function.ts         Creates a run, starts the chain
      lead-search-page.logic-function.ts        One page, then enqueues itself
    views/leads.view.ts
    navigation-menu-items/leads.navigation-menu-item.ts
```

Source adapters and mapping are pure modules so they unit-test without a server. Only the three orchestration files are logic functions.

---

## How the API key is configured

The app declares the key in its manifest but never holds a value. This is Twenty's own mechanism, not something we build:

```text
  application-config.ts               server                          admin UI
  serverVariables: {          syncVariableSchemas()          Settings > Admin Panel > Apps
    GOOGLE_MAPS_API_KEY  ──▶  creates a row in         ──▶   admin types the key,
      { isSecret: true }      core.applicationRegistration   stored in encryptedValue
  }                           Variable (empty value)
                                        │
                                        ▼
                          logic-function-executor.service.ts
                          buildServerVariableEnvMap() injects it as
                          process.env.GOOGLE_MAPS_API_KEY at run time
```

What this gives you, all of it built in:

| Property | Detail |
|---|---|
| Where it is edited | **Settings → Admin Panel → Apps** (`SettingsAdminApps.tsx`, tab id `apps`). Also on the app registration's own **Config** tab (`SettingsApplicationRegistrationConfigTab.tsx`). |
| Storage | `core.applicationRegistrationVariable.encryptedValue`, encrypted at rest. `isSecret` defaults to `true`, and secret values are masked on read. |
| Scope | The **application registration**, i.e. server-level, not per workspace. One key serves every workspace that installs the app. |
| Lifecycle | `syncVariableSchemas()` runs on every deploy: it creates newly declared variables, updates their description and type, and deletes ones you removed from the manifest. An admin-entered value survives redeploys. |
| Injection | `buildServerVariableEnvMap()` in `logic-function-executor.service.ts` puts it into `process.env` for logic functions only. Front components never receive secret values. |
| Validation | `isRequired: true` marks it as required in the UI. |

`serverVariables` also accepts a `type` (and `options` for `SELECT`) so the admin panel renders the right input rather than a plain text box. Values always arrive in `process.env` as strings regardless of type, so parse accordingly.

Do not use `applicationVariables` for this. Those carry a default value in the manifest and are workspace-scoped, which is right for tunables like a batch size and wrong for a credential.

---

### Task 1: Scaffold the app, role, and configuration

**Files:**
- Create: `twenty-lead-discovery/` (via scaffolder)
- Modify: `twenty-lead-discovery/src/application-config.ts`
- Create: `twenty-lead-discovery/src/roles/lead-discovery.role.ts`
- Create: `twenty-lead-discovery/src/constants/universal-identifiers.ts`

**Interfaces:**
- Produces: `LEAD_DISCOVERY_IDS` constant object, imported by every later task for stable UUIDs.

- [ ] **Step 1: Scaffold the project**

Run from the directory where you keep your apps (not inside the twenty monorepo):

```bash
npx create-twenty-app@latest twenty-lead-discovery \
  --display-name "Lead Discovery" \
  --description "Turns saved search criteria into deduplicated business leads"
cd twenty-lead-discovery
```

Docker must be running. The scaffolder pulls `twentycrm/twenty-app-dev`, starts it on port 2020, and authorizes the CLI against the seeded demo workspace.

- [ ] **Step 2: Verify the dev loop works before writing any code**

```bash
yarn twenty dev
```

Open http://localhost:2020/settings/applications#developer. Expected: **Lead Discovery** listed under Your Apps. Stop the watcher with Ctrl-C once confirmed.

If Docker was not running, start it and resume with `yarn twenty docker:start`.

- [ ] **Step 3: Generate the UUIDs**

```bash
for i in $(seq 1 24); do uuidgen | tr '[:upper:]' '[:lower:]'; done
```

Paste them into the constants file below, one per slot. Never regenerate these.

- [ ] **Step 4: Write the identifier constants**

```ts
// src/constants/universal-identifiers.ts
// Every universalIdentifier in this app. These are stable forever —
// changing one drops and recreates the entity, losing its data.
export const LEAD_DISCOVERY_IDS = {
  application: 'REPLACE-WITH-UUID-01',
  role: 'REPLACE-WITH-UUID-02',
  googleMapsApiKeyVariable: 'REPLACE-WITH-UUID-03',

  leadObject: 'REPLACE-WITH-UUID-04',
  leadSearchObject: 'REPLACE-WITH-UUID-05',
  leadSearchRunObject: 'REPLACE-WITH-UUID-06',
  leadSuppressionObject: 'REPLACE-WITH-UUID-07',

  leadFields: {
    domain: 'REPLACE-WITH-UUID-08',
    website: 'REPLACE-WITH-UUID-09',
    phones: 'REPLACE-WITH-UUID-10',
    emails: 'REPLACE-WITH-UUID-11',
    address: 'REPLACE-WITH-UUID-12',
    category: 'REPLACE-WITH-UUID-13',
    status: 'REPLACE-WITH-UUID-14',
    sourceProvider: 'REPLACE-WITH-UUID-15',
    sourceExternalId: 'REPLACE-WITH-UUID-16',
    sourceUrl: 'REPLACE-WITH-UUID-17',
    collectedAt: 'REPLACE-WITH-UUID-18',
    legalBasis: 'REPLACE-WITH-UUID-19',
  },

  leadSearchFields: {
    isActive: 'REPLACE-WITH-UUID-20',
    criteria: 'REPLACE-WITH-UUID-21',
    lastRunAt: 'REPLACE-WITH-UUID-22',
  },

  leadSearchRunFields: {
    status: 'REPLACE-WITH-UUID-23',
    startedAt: 'REPLACE-WITH-UUID-24',
  },
} as const;
```

Task 3 adds a second batch of UUIDs for the remaining fields and relations. Generate those when you get there.

- [ ] **Step 5: Write the role**

```ts
// src/roles/lead-discovery.role.ts
import { defineApplicationRole } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

// The logic functions read and write this app's own four objects and
// nothing else. Least privilege: no access to Person, Company, or any
// standard object until the promotion feature exists.
export default defineApplicationRole({
  universalIdentifier: LEAD_DISCOVERY_IDS.role,
  label: 'Lead Discovery function role',
  description: 'Read and write Lead Discovery records only',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
  canBeAssignedToAgents: false,
  objectPermissions: [
    {
      objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadObject,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
    },
    {
      objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadSearchObject,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
    },
    {
      objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunObject,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
    },
    {
      objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadSuppressionObject,
      canReadObjectRecords: true,
    },
  ],
  fieldPermissions: [],
});
```

Suppression is read-only for the functions. Only a human removes someone from it.

- [ ] **Step 6: Write the application config**

```ts
// src/application-config.ts
import { defineApplication, FieldType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from './constants/universal-identifiers';

export default defineApplication({
  universalIdentifier: LEAD_DISCOVERY_IDS.application,
  displayName: 'Lead Discovery',
  description:
    'Turns saved, dynamic search criteria into deduplicated business leads with full provenance.',
  // Instance-scoped configuration. No values live here — an admin fills
  // them in at Settings > Admin Panel > Apps, and the platform stores
  // them encrypted against the application registration.
  serverVariables: {
    GOOGLE_MAPS_API_KEY: {
      description:
        'Google Maps Platform API key with the Places API (New) enabled. Billing must be active on the Google Cloud project.',
      isSecret: true,
      isRequired: true,
    },
    LEAD_DISCOVERY_DEFAULT_REGION: {
      description:
        'Two-letter CLDR region code used when a lead search does not specify one.',
      type: FieldType.SELECT,
      options: [
        { label: 'Germany', value: 'DE' },
        { label: 'Austria', value: 'AT' },
        { label: 'Switzerland', value: 'CH' },
      ],
      isSecret: false,
      isRequired: false,
    },
  },
});
```

The second variable is there to prove the `type` and `options` path renders a dropdown in the admin panel rather than a free-text box. Nothing in this plan reads it yet.

- [ ] **Step 7: Sync, then configure the key in the admin panel**

```bash
yarn twenty apply
```

Expected: exit code 0.

Then, in the UI:

1. Go to **Settings → Admin Panel → Apps**.
2. Select **Lead Discovery**.
3. `GOOGLE_MAPS_API_KEY` is listed as required and empty, `LEAD_DISCOVERY_DEFAULT_REGION` renders as a dropdown with the three options.
4. Paste your Places API key and save.
5. Reload the page. Expected: the value is masked, not echoed back, because `isSecret` is `true`.

Verify the round trip reaches the runtime before building anything on top of it:

```bash
yarn twenty dev:function:exec -n lead-search-page -p '{}'
yarn twenty dev:function:logs
```

Expected: the function fails on `Lead search  not found`, **not** on `GOOGLE_MAPS_API_KEY is not configured`. Reaching the second error message means the key never made it into `process.env`, and nothing downstream will work until that is fixed.

The `lead-search-page` function does not exist until Task 9. Run this verification step then, and treat it as a gate before Task 10.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold lead discovery app with role and config"
```

---

### Task 2: The Lead object

**Files:**
- Create: `src/objects/lead.object.ts`

**Interfaces:**
- Produces: a `lead` object with `domain`, `sourceProvider`, `sourceExternalId`, `collectedAt`, `legalBasis`, `status`. Tasks 7, 8, and 9 write these exact field names.

- [ ] **Step 1: Write the object**

```ts
// src/objects/lead.object.ts
import { defineObject, FieldType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export enum LeadStatus {
  NEW = 'NEW',
  QUALIFIED = 'QUALIFIED',
  REJECTED = 'REJECTED',
  PROMOTED = 'PROMOTED',
}

export enum LeadSourceProvider {
  GOOGLE_PLACES = 'GOOGLE_PLACES',
  IMPRESSUM = 'IMPRESSUM',
  MANUAL = 'MANUAL',
}

export enum LeadLegalBasis {
  LEGITIMATE_INTEREST = 'LEGITIMATE_INTEREST',
  CONSENT = 'CONSENT',
}

export default defineObject({
  universalIdentifier: LEAD_DISCOVERY_IDS.leadObject,
  nameSingular: 'lead',
  namePlural: 'leads',
  labelSingular: 'Lead',
  labelPlural: 'Leads',
  description: 'A discovered business prospect, before promotion to Company',
  icon: 'IconTargetArrow',
  fields: [
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.domain,
      name: 'domain',
      type: FieldType.TEXT,
      label: 'Domain',
      description: 'Normalized website hostname. The primary dedupe key.',
      icon: 'IconWorld',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.website,
      name: 'website',
      type: FieldType.LINKS,
      label: 'Website',
      icon: 'IconLink',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.phones,
      name: 'phones',
      type: FieldType.PHONES,
      label: 'Phones',
      icon: 'IconPhone',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.emails,
      name: 'emails',
      type: FieldType.EMAILS,
      label: 'Emails',
      icon: 'IconMail',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.address,
      name: 'address',
      type: FieldType.ADDRESS,
      label: 'Address',
      icon: 'IconMapPin',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.category,
      name: 'category',
      type: FieldType.TEXT,
      label: 'Category',
      description: 'Primary business type reported by the source',
      icon: 'IconCategory',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.status,
      name: 'status',
      type: FieldType.SELECT,
      label: 'Status',
      icon: 'IconProgressCheck',
      defaultValue: `'${LeadStatus.NEW}'`,
      options: [
        { value: LeadStatus.NEW, label: 'New', position: 0, color: 'blue' },
        { value: LeadStatus.QUALIFIED, label: 'Qualified', position: 1, color: 'green' },
        { value: LeadStatus.REJECTED, label: 'Rejected', position: 2, color: 'red' },
        { value: LeadStatus.PROMOTED, label: 'Promoted', position: 3, color: 'purple' },
      ],
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.sourceProvider,
      name: 'sourceProvider',
      type: FieldType.SELECT,
      label: 'Source',
      icon: 'IconDatabase',
      defaultValue: `'${LeadSourceProvider.GOOGLE_PLACES}'`,
      options: [
        { value: LeadSourceProvider.GOOGLE_PLACES, label: 'Google Places', position: 0, color: 'blue' },
        { value: LeadSourceProvider.IMPRESSUM, label: 'Impressum', position: 1, color: 'green' },
        { value: LeadSourceProvider.MANUAL, label: 'Manual', position: 2, color: 'gray' },
      ],
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.sourceExternalId,
      name: 'sourceExternalId',
      type: FieldType.TEXT,
      label: 'Source external ID',
      description:
        'Provider record id. For Google Places this is the place id, the only Places field permitted to be cached indefinitely.',
      icon: 'IconFingerprint',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.sourceUrl,
      name: 'sourceUrl',
      type: FieldType.TEXT,
      label: 'Source URL',
      icon: 'IconExternalLink',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.collectedAt,
      name: 'collectedAt',
      type: FieldType.DATE_TIME,
      label: 'Collected at',
      icon: 'IconClock',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadFields.legalBasis,
      name: 'legalBasis',
      type: FieldType.SELECT,
      label: 'Legal basis',
      description: 'GDPR Art. 6 basis recorded at collection time',
      icon: 'IconScale',
      defaultValue: `'${LeadLegalBasis.LEGITIMATE_INTEREST}'`,
      options: [
        { value: LeadLegalBasis.LEGITIMATE_INTEREST, label: 'Legitimate interest', position: 0, color: 'orange' },
        { value: LeadLegalBasis.CONSENT, label: 'Consent', position: 1, color: 'green' },
      ],
    },
  ],
});
```

`name`, `id`, `createdAt`, `updatedAt`, and `deletedAt` are added automatically. Do not declare them.

- [ ] **Step 2: Sync and verify the object exists**

```bash
yarn twenty apply
```

Expected: exit 0. Open http://localhost:2020 and confirm a **Leads** object exists in Settings → Data model with all eleven custom fields.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Lead object with provenance fields"
```

---

### Task 3: LeadSearch, LeadSearchRun, LeadSuppression, and relations

**Files:**
- Create: `src/objects/lead-search.object.ts`
- Create: `src/objects/lead-search-run.object.ts`
- Create: `src/objects/lead-suppression.object.ts`
- Create: `src/fields/lead-search-runs-on-lead-search.field.ts`
- Create: `src/fields/lead-search-on-lead-search-run.field.ts`
- Modify: `src/constants/universal-identifiers.ts`

**Interfaces:**
- Produces: `leadSearch` with `criteria` (RAW_JSON) and `isActive`; `leadSearchRun` with counter fields `resultCount`, `newCount`, `duplicateCount`, `suppressedCount`; `leadSuppression` with `domain`. Task 9 reads and writes all of these.

- [ ] **Step 1: Add the second batch of UUIDs**

Generate eleven more UUIDs and extend the constants file:

```ts
// append inside LEAD_DISCOVERY_IDS in src/constants/universal-identifiers.ts
  leadSearchRunCounterFields: {
    finishedAt: 'REPLACE-WITH-UUID-25',
    resultCount: 'REPLACE-WITH-UUID-26',
    newCount: 'REPLACE-WITH-UUID-27',
    duplicateCount: 'REPLACE-WITH-UUID-28',
    suppressedCount: 'REPLACE-WITH-UUID-29',
    errorMessage: 'REPLACE-WITH-UUID-30',
  },
  leadSuppressionFields: {
    domain: 'REPLACE-WITH-UUID-31',
    reason: 'REPLACE-WITH-UUID-32',
    suppressedAt: 'REPLACE-WITH-UUID-33',
  },
  relations: {
    leadSearchRunsOnLeadSearch: 'REPLACE-WITH-UUID-34',
    leadSearchOnLeadSearchRun: 'REPLACE-WITH-UUID-35',
  },
```

- [ ] **Step 2: Write LeadSearch**

```ts
// src/objects/lead-search.object.ts
import { defineObject, FieldType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export default defineObject({
  universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchObject,
  nameSingular: 'leadSearch',
  namePlural: 'leadSearches',
  labelSingular: 'Lead Search',
  labelPlural: 'Lead Searches',
  description: 'Saved, dynamic criteria that produce leads when run',
  icon: 'IconZoomScan',
  fields: [
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchFields.isActive,
      name: 'isActive',
      type: FieldType.BOOLEAN,
      label: 'Active',
      description: 'Only active searches are picked up by the scheduler',
      icon: 'IconToggleLeft',
      defaultValue: false,
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchFields.criteria,
      name: 'criteria',
      type: FieldType.RAW_JSON,
      label: 'Criteria',
      description: 'LeadSearchCriteria JSON. See the app README for the schema.',
      icon: 'IconAdjustments',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchFields.lastRunAt,
      name: 'lastRunAt',
      type: FieldType.DATE_TIME,
      label: 'Last run at',
      icon: 'IconClock',
    },
  ],
});
```

- [ ] **Step 3: Write LeadSearchRun**

```ts
// src/objects/lead-search-run.object.ts
import { defineObject, FieldType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export enum LeadSearchRunStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export default defineObject({
  universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunObject,
  nameSingular: 'leadSearchRun',
  namePlural: 'leadSearchRuns',
  labelSingular: 'Lead Search Run',
  labelPlural: 'Lead Search Runs',
  description: 'One execution of a lead search',
  icon: 'IconPlayerPlay',
  fields: [
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunFields.status,
      name: 'status',
      type: FieldType.SELECT,
      label: 'Status',
      icon: 'IconProgressCheck',
      defaultValue: `'${LeadSearchRunStatus.RUNNING}'`,
      options: [
        { value: LeadSearchRunStatus.RUNNING, label: 'Running', position: 0, color: 'blue' },
        { value: LeadSearchRunStatus.COMPLETED, label: 'Completed', position: 1, color: 'green' },
        { value: LeadSearchRunStatus.FAILED, label: 'Failed', position: 2, color: 'red' },
      ],
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunFields.startedAt,
      name: 'startedAt',
      type: FieldType.DATE_TIME,
      label: 'Started at',
      icon: 'IconClock',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunCounterFields.finishedAt,
      name: 'finishedAt',
      type: FieldType.DATE_TIME,
      label: 'Finished at',
      icon: 'IconClockCheck',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunCounterFields.resultCount,
      name: 'resultCount',
      type: FieldType.NUMBER,
      label: 'Results seen',
      icon: 'IconSum',
      defaultValue: 0,
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunCounterFields.newCount,
      name: 'newCount',
      type: FieldType.NUMBER,
      label: 'New leads',
      icon: 'IconPlus',
      defaultValue: 0,
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunCounterFields.duplicateCount,
      name: 'duplicateCount',
      type: FieldType.NUMBER,
      label: 'Duplicates skipped',
      icon: 'IconCopy',
      defaultValue: 0,
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunCounterFields.suppressedCount,
      name: 'suppressedCount',
      type: FieldType.NUMBER,
      label: 'Suppressed skipped',
      icon: 'IconBan',
      defaultValue: 0,
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunCounterFields.errorMessage,
      name: 'errorMessage',
      type: FieldType.TEXT,
      label: 'Error',
      icon: 'IconAlertTriangle',
    },
  ],
});
```

- [ ] **Step 4: Write LeadSuppression**

```ts
// src/objects/lead-suppression.object.ts
import { defineObject, FieldType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export enum LeadSuppressionReason {
  OPT_OUT = 'OPT_OUT',
  COMPLAINT = 'COMPLAINT',
  EXISTING_CUSTOMER = 'EXISTING_CUSTOMER',
  MANUAL = 'MANUAL',
}

export default defineObject({
  universalIdentifier: LEAD_DISCOVERY_IDS.leadSuppressionObject,
  nameSingular: 'leadSuppression',
  namePlural: 'leadSuppressions',
  labelSingular: 'Lead Suppression',
  labelPlural: 'Lead Suppressions',
  description:
    'Domains that must never be re-added by a search run. Checked before every insert.',
  icon: 'IconBan',
  fields: [
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSuppressionFields.domain,
      name: 'domain',
      type: FieldType.TEXT,
      label: 'Domain',
      description: 'Normalized hostname, matching Lead.domain',
      icon: 'IconWorld',
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSuppressionFields.reason,
      name: 'reason',
      type: FieldType.SELECT,
      label: 'Reason',
      icon: 'IconQuestionMark',
      defaultValue: `'${LeadSuppressionReason.MANUAL}'`,
      options: [
        { value: LeadSuppressionReason.OPT_OUT, label: 'Opted out', position: 0, color: 'red' },
        { value: LeadSuppressionReason.COMPLAINT, label: 'Complaint', position: 1, color: 'red' },
        { value: LeadSuppressionReason.EXISTING_CUSTOMER, label: 'Existing customer', position: 2, color: 'blue' },
        { value: LeadSuppressionReason.MANUAL, label: 'Manual', position: 3, color: 'gray' },
      ],
    },
    {
      universalIdentifier: LEAD_DISCOVERY_IDS.leadSuppressionFields.suppressedAt,
      name: 'suppressedAt',
      type: FieldType.DATE_TIME,
      label: 'Suppressed at',
      icon: 'IconClock',
      defaultValue: 'now',
    },
  ],
});
```

`defaultValue: 'now'` is unquoted on purpose. It is a computed default, not a literal.

- [ ] **Step 5: Write the ONE_TO_MANY side of the run relation**

```ts
// src/fields/lead-search-runs-on-lead-search.field.ts
import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export default defineField({
  universalIdentifier: LEAD_DISCOVERY_IDS.relations.leadSearchRunsOnLeadSearch,
  objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadSearchObject,
  type: FieldType.RELATION,
  name: 'leadSearchRuns',
  label: 'Runs',
  icon: 'IconHistory',
  relationTargetObjectMetadataUniversalIdentifier:
    LEAD_DISCOVERY_IDS.leadSearchRunObject,
  relationTargetFieldMetadataUniversalIdentifier:
    LEAD_DISCOVERY_IDS.relations.leadSearchOnLeadSearchRun,
  universalSettings: { relationType: RelationType.ONE_TO_MANY },
});
```

- [ ] **Step 6: Write the MANY_TO_ONE side**

```ts
// src/fields/lead-search-on-lead-search-run.field.ts
import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export default defineField({
  universalIdentifier: LEAD_DISCOVERY_IDS.relations.leadSearchOnLeadSearchRun,
  objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadSearchRunObject,
  type: FieldType.RELATION,
  name: 'leadSearch',
  label: 'Lead Search',
  icon: 'IconZoomScan',
  relationTargetObjectMetadataUniversalIdentifier:
    LEAD_DISCOVERY_IDS.leadSearchObject,
  relationTargetFieldMetadataUniversalIdentifier:
    LEAD_DISCOVERY_IDS.relations.leadSearchRunsOnLeadSearch,
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
  },
});
```

- [ ] **Step 7: Sync and regenerate the typed client**

```bash
yarn twenty apply
```

Expected: exit 0. This regenerates `CoreApiClient` so later tasks get typed `leads`, `leadSearches`, `leadSearchRuns`, and `leadSuppressions` operations. **Tasks 8 onward will not typecheck until this sync succeeds.**

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add LeadSearch, LeadSearchRun, LeadSuppression and run relation"
```

---

### Task 4: Criteria types and query expansion

**Files:**
- Create: `src/lib/criteria/criteria.type.ts`
- Create: `src/lib/criteria/expand-criteria-to-queries.ts`
- Test: `src/lib/criteria/__tests__/expand-criteria-to-queries.test.ts`

**Interfaces:**
- Produces: `type LeadSearchCriteria`, `type PlacesQuery`, `expandCriteriaToQueries(criteria: LeadSearchCriteria): PlacesQuery[]`, and `parseCriteria(raw: unknown): LeadSearchCriteria`. Task 9 calls both functions.

This is the heart of "dynamic criteria". Because Places caps a single query at 60 results, volume comes from the number of queries, not the depth of paging. One criteria record fans out to `categories.length * locations.length` queries.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/criteria/__tests__/expand-criteria-to-queries.test.ts
import { describe, expect, it } from 'vitest';

import { type LeadSearchCriteria } from '../criteria.type';
import { expandCriteriaToQueries, parseCriteria } from '../expand-criteria-to-queries';

const baseCriteria: LeadSearchCriteria = {
  categories: ['dentist', 'physiotherapist'],
  locations: ['Munich, Germany', 'Berlin, Germany'],
  keywords: [],
  requireWebsite: true,
  languageCode: 'de',
  regionCode: 'DE',
  maxPagesPerQuery: 3,
};

describe('expandCriteriaToQueries', () => {
  it('should produce the cartesian product of categories and locations', () => {
    const queries = expandCriteriaToQueries(baseCriteria);

    expect(queries).toHaveLength(4);
    expect(queries.map((query) => query.textQuery)).toEqual([
      'dentist in Munich, Germany',
      'dentist in Berlin, Germany',
      'physiotherapist in Munich, Germany',
      'physiotherapist in Berlin, Germany',
    ]);
  });

  it('should carry the category through as includedType', () => {
    const queries = expandCriteriaToQueries(baseCriteria);

    expect(queries[0].includedType).toBe('dentist');
    expect(queries[0].languageCode).toBe('de');
    expect(queries[0].regionCode).toBe('DE');
  });

  it('should append keywords to the text query', () => {
    const queries = expandCriteriaToQueries({
      ...baseCriteria,
      categories: ['dentist'],
      locations: ['Munich, Germany'],
      keywords: ['implants', 'private'],
    });

    expect(queries[0].textQuery).toBe('dentist implants private in Munich, Germany');
  });

  it('should work with keywords and no categories', () => {
    const queries = expandCriteriaToQueries({
      ...baseCriteria,
      categories: [],
      locations: ['Hamburg, Germany'],
      keywords: ['coworking space'],
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].textQuery).toBe('coworking space in Hamburg, Germany');
    expect(queries[0].includedType).toBeUndefined();
  });

  it('should throw when neither categories nor keywords are given', () => {
    expect(() =>
      expandCriteriaToQueries({ ...baseCriteria, categories: [], keywords: [] }),
    ).toThrow('at least one category or keyword');
  });

  it('should throw when no locations are given', () => {
    expect(() => expandCriteriaToQueries({ ...baseCriteria, locations: [] })).toThrow(
      'at least one location',
    );
  });
});

describe('parseCriteria', () => {
  it('should apply defaults for omitted optional fields', () => {
    const criteria = parseCriteria({
      categories: ['bakery'],
      locations: ['Cologne, Germany'],
    });

    expect(criteria).toEqual({
      categories: ['bakery'],
      locations: ['Cologne, Germany'],
      keywords: [],
      requireWebsite: true,
      languageCode: 'de',
      regionCode: 'DE',
      maxPagesPerQuery: 3,
    });
  });

  it('should clamp maxPagesPerQuery to the Places three-page ceiling', () => {
    const criteria = parseCriteria({
      categories: ['bakery'],
      locations: ['Cologne, Germany'],
      maxPagesPerQuery: 99,
    });

    expect(criteria.maxPagesPerQuery).toBe(3);
  });

  it('should reject a non-object payload', () => {
    expect(() => parseCriteria('nope')).toThrow('criteria must be an object');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../criteria.type` and `../expand-criteria-to-queries`.

- [ ] **Step 3: Write the types**

```ts
// src/lib/criteria/criteria.type.ts

// The dynamic criteria a business configures on a LeadSearch record.
// Stored as RAW_JSON so it can evolve without a schema migration.
export type LeadSearchCriteria = {
  // Google Places `includedType` values, e.g. 'dentist'. Empty means
  // keyword-only search.
  categories: string[];
  // Free-text localities, e.g. 'Munich, Germany'.
  locations: string[];
  keywords: string[];
  requireWebsite: boolean;
  languageCode: string;
  regionCode: string;
  // Places returns at most 3 pages (60 results) per query.
  maxPagesPerQuery: number;
};

export type PlacesQuery = {
  textQuery: string;
  includedType?: string;
  languageCode: string;
  regionCode: string;
};
```

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/criteria/expand-criteria-to-queries.ts
import { type LeadSearchCriteria, type PlacesQuery } from './criteria.type';

// Places Text Search hard-caps at 3 pages of 20.
const MAX_PAGES_CEILING = 3;

const DEFAULTS = {
  keywords: [] as string[],
  requireWebsite: true,
  languageCode: 'de',
  regionCode: 'DE',
  maxPagesPerQuery: MAX_PAGES_CEILING,
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

export const parseCriteria = (raw: unknown): LeadSearchCriteria => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('criteria must be an object');
  }

  const input = raw as Record<string, unknown>;

  return {
    categories: asStringArray(input.categories),
    locations: asStringArray(input.locations),
    keywords: input.keywords === undefined ? DEFAULTS.keywords : asStringArray(input.keywords),
    requireWebsite:
      typeof input.requireWebsite === 'boolean' ? input.requireWebsite : DEFAULTS.requireWebsite,
    languageCode:
      typeof input.languageCode === 'string' ? input.languageCode : DEFAULTS.languageCode,
    regionCode: typeof input.regionCode === 'string' ? input.regionCode : DEFAULTS.regionCode,
    maxPagesPerQuery: Math.min(
      typeof input.maxPagesPerQuery === 'number' ? input.maxPagesPerQuery : DEFAULTS.maxPagesPerQuery,
      MAX_PAGES_CEILING,
    ),
  };
};

export const expandCriteriaToQueries = (criteria: LeadSearchCriteria): PlacesQuery[] => {
  if (criteria.categories.length === 0 && criteria.keywords.length === 0) {
    throw new Error('criteria needs at least one category or keyword');
  }

  if (criteria.locations.length === 0) {
    throw new Error('criteria needs at least one location');
  }

  const keywordSuffix =
    criteria.keywords.length > 0 ? ` ${criteria.keywords.join(' ')}` : '';

  const categories: (string | undefined)[] =
    criteria.categories.length > 0 ? criteria.categories : [undefined];

  return categories.flatMap((category) =>
    criteria.locations.map((location) => ({
      textQuery: `${category ?? ''}${keywordSuffix}`.trim() + ` in ${location}`,
      includedType: category,
      languageCode: criteria.languageCode,
      regionCode: criteria.regionCode,
    })),
  );
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: expand lead search criteria into a Places query matrix"
```

---

### Task 5: Domain normalization

**Files:**
- Create: `src/lib/dedupe/normalize-domain.ts`
- Test: `src/lib/dedupe/__tests__/normalize-domain.test.ts`

**Interfaces:**
- Produces: `normalizeDomain(websiteUri: string | undefined | null): string | null`. Tasks 7 and 8 call it.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/dedupe/__tests__/normalize-domain.test.ts
import { describe, expect, it } from 'vitest';

import { normalizeDomain } from '../normalize-domain';

describe('normalizeDomain', () => {
  it('should strip protocol, www, path, and query', () => {
    expect(normalizeDomain('https://www.Example.com/kontakt?utm=x')).toBe('example.com');
  });

  it('should keep a non-www subdomain', () => {
    expect(normalizeDomain('https://praxis.example.de')).toBe('praxis.example.de');
  });

  it('should lowercase the host', () => {
    expect(normalizeDomain('http://EXAMPLE.DE')).toBe('example.de');
  });

  it('should return null for undefined, null, and empty input', () => {
    expect(normalizeDomain(undefined)).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });

  it('should return null for an unparseable value', () => {
    expect(normalizeDomain('not a url')).toBeNull();
  });

  it('should accept a bare hostname without a scheme', () => {
    expect(normalizeDomain('www.example.com')).toBe('example.com');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../normalize-domain`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/dedupe/normalize-domain.ts

// The dedupe key for a lead. Two records with the same normalized domain
// are the same business, regardless of which source found them.
export const normalizeDomain = (websiteUri: string | undefined | null): string | null => {
  if (typeof websiteUri !== 'string' || websiteUri.trim() === '') {
    return null;
  }

  const candidate = /^https?:\/\//i.test(websiteUri) ? websiteUri : `https://${websiteUri}`;

  try {
    const hostname = new URL(candidate).hostname.toLowerCase();

    // A hostname with no dot is not a real domain — 'not a url' parses to
    // the host 'not%20a%20url' without one.
    if (!hostname.includes('.')) {
      return null;
    }

    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add domain normalization for lead deduplication"
```

---

### Task 6: Google Places client

**Files:**
- Create: `src/lib/sources/google-places/google-places.type.ts`
- Create: `src/lib/sources/google-places/google-places-client.ts`
- Test: `src/lib/sources/google-places/__tests__/google-places-client.test.ts`

**Interfaces:**
- Produces: `type GooglePlace`, `type PlacesSearchPage`, and `searchPlacesPage(input: { apiKey: string; query: PlacesQuery; pageToken?: string }): Promise<PlacesSearchPage>`. Task 9 calls `searchPlacesPage`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/sources/google-places/__tests__/google-places-client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PlacesQuery } from '../../../criteria/criteria.type';
import { searchPlacesPage } from '../google-places-client';

const query: PlacesQuery = {
  textQuery: 'dentist in Munich, Germany',
  includedType: 'dentist',
  languageCode: 'de',
  regionCode: 'DE',
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchPlacesPage', () => {
  it('should post to the Places searchText endpoint with the api key and field mask', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ places: [], nextPageToken: undefined }),
    });

    await searchPlacesPage({ apiKey: 'test-key', query });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(init.headers['X-Goog-FieldMask']).toContain('places.id');
    expect(init.headers['X-Goog-FieldMask']).toContain('nextPageToken');
  });

  it('should send the query fields and a page size of 20', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ places: [] }) });

    await searchPlacesPage({ apiKey: 'test-key', query });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body).toEqual({
      textQuery: 'dentist in Munich, Germany',
      includedType: 'dentist',
      languageCode: 'de',
      regionCode: 'DE',
      pageSize: 20,
    });
  });

  it('should include the page token when one is given', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ places: [] }) });

    await searchPlacesPage({ apiKey: 'test-key', query, pageToken: 'tok-123' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body.pageToken).toBe('tok-123');
  });

  it('should omit includedType when the query has none', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ places: [] }) });

    await searchPlacesPage({
      apiKey: 'test-key',
      query: { ...query, includedType: undefined },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect('includedType' in body).toBe(false);
  });

  it('should return places and the next page token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        places: [{ id: 'place-1', displayName: { text: 'Zahnarzt Meier' } }],
        nextPageToken: 'tok-next',
      }),
    });

    const page = await searchPlacesPage({ apiKey: 'test-key', query });

    expect(page.places).toHaveLength(1);
    expect(page.places[0].id).toBe('place-1');
    expect(page.nextPageToken).toBe('tok-next');
  });

  it('should default places to an empty array when the response omits it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    const page = await searchPlacesPage({ apiKey: 'test-key', query });

    expect(page.places).toEqual([]);
    expect(page.nextPageToken).toBeUndefined();
  });

  it('should throw with the status and body when the request fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'RESOURCE_EXHAUSTED',
    });

    await expect(searchPlacesPage({ apiKey: 'test-key', query })).rejects.toThrow(
      'Google Places request failed with 429: RESOURCE_EXHAUSTED',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../google-places-client`.

- [ ] **Step 3: Write the wire types**

```ts
// src/lib/sources/google-places/google-places.type.ts

export type GooglePlaceAddressComponent = {
  longText?: string;
  shortText?: string;
  types: string[];
};

export type GooglePlace = {
  id: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  addressComponents?: GooglePlaceAddressComponent[];
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  primaryType?: string;
};

export type PlacesSearchPage = {
  places: GooglePlace[];
  nextPageToken?: string;
};
```

- [ ] **Step 4: Write the client**

```ts
// src/lib/sources/google-places/google-places-client.ts
import { type PlacesQuery } from '../../criteria/criteria.type';
import { type GooglePlace, type PlacesSearchPage } from './google-places.type';

const PLACES_SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

// Places bills by field mask tier. Request exactly what we map, no more.
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.primaryType',
  'nextPageToken',
].join(',');

const PAGE_SIZE = 20;

export const searchPlacesPage = async ({
  apiKey,
  query,
  pageToken,
}: {
  apiKey: string;
  query: PlacesQuery;
  pageToken?: string;
}): Promise<PlacesSearchPage> => {
  const body: Record<string, unknown> = {
    textQuery: query.textQuery,
    languageCode: query.languageCode,
    regionCode: query.regionCode,
    pageSize: PAGE_SIZE,
  };

  if (query.includedType !== undefined) {
    body.includedType = query.includedType;
  }

  if (pageToken !== undefined) {
    body.pageToken = pageToken;
  }

  const response = await fetch(PLACES_SEARCH_TEXT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();

    throw new Error(
      `Google Places request failed with ${response.status}: ${detail}`,
    );
  }

  const payload = (await response.json()) as {
    places?: GooglePlace[];
    nextPageToken?: string;
  };

  return {
    places: payload.places ?? [],
    nextPageToken: payload.nextPageToken,
  };
};
```

Note the key ordering in the body: the test asserts `includedType` sits between `textQuery` and `languageCode` only via `toEqual`, which ignores key order. Do not reorder to satisfy a diff.

- [ ] **Step 5: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Google Places text search client"
```

---

### Task 7: Map a Place to a Lead input

**Files:**
- Create: `src/lib/sources/google-places/parse-phone.ts`
- Create: `src/lib/sources/google-places/map-place-to-lead.ts`
- Test: `src/lib/sources/google-places/__tests__/parse-phone.test.ts`
- Test: `src/lib/sources/google-places/__tests__/map-place-to-lead.test.ts`

**Interfaces:**
- Produces: `parsePhone(international: string | undefined)`, and `mapPlaceToLead(place: GooglePlace, collectedAt: string): LeadInput | null`. Task 9 calls `mapPlaceToLead`.

`mapPlaceToLead` returns `null` when the place has no resolvable domain. A business with no website cannot be deduplicated and cannot be researched, so it is not worth a record.

- [ ] **Step 1: Write the failing phone test**

```ts
// src/lib/sources/google-places/__tests__/parse-phone.test.ts
import { describe, expect, it } from 'vitest';

import { parsePhone } from '../parse-phone';

describe('parsePhone', () => {
  it('should split the calling code from the number', () => {
    expect(parsePhone('+49 89 123456')).toEqual({
      primaryPhoneCallingCode: '+49',
      primaryPhoneNumber: '89123456',
      additionalPhones: [],
    });
  });

  it('should strip dashes and parentheses', () => {
    expect(parsePhone('+1 (415) 555-0100')).toEqual({
      primaryPhoneCallingCode: '+1',
      primaryPhoneNumber: '4155550100',
      additionalPhones: [],
    });
  });

  it('should fall back to an empty calling code without a leading plus', () => {
    expect(parsePhone('089 123456')).toEqual({
      primaryPhoneCallingCode: '',
      primaryPhoneNumber: '089123456',
      additionalPhones: [],
    });
  });

  it('should return null for undefined and empty input', () => {
    expect(parsePhone(undefined)).toBeNull();
    expect(parsePhone('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../parse-phone`.

- [ ] **Step 3: Write parsePhone**

```ts
// src/lib/sources/google-places/parse-phone.ts

export type TwentyPhones = {
  primaryPhoneCallingCode: string;
  primaryPhoneNumber: string;
  additionalPhones: never[];
};

// Places returns E.164-ish strings like '+49 89 123456'. Twenty's PHONES
// composite wants the calling code in its own sub-field.
export const parsePhone = (international: string | undefined): TwentyPhones | null => {
  if (typeof international !== 'string' || international.trim() === '') {
    return null;
  }

  const digitsOnly = (value: string) => value.replace(/[^\d]/g, '');
  const match = international.match(/^(\+\d{1,3})\s+(.*)$/);

  if (match === null) {
    return {
      primaryPhoneCallingCode: '',
      primaryPhoneNumber: digitsOnly(international),
      additionalPhones: [],
    };
  }

  return {
    primaryPhoneCallingCode: match[1],
    primaryPhoneNumber: digitsOnly(match[2]),
    additionalPhones: [],
  };
};
```

- [ ] **Step 4: Run it to verify it passes**

```bash
yarn test:unit
```

Expected: PASS.

- [ ] **Step 5: Write the failing mapping test**

```ts
// src/lib/sources/google-places/__tests__/map-place-to-lead.test.ts
import { describe, expect, it } from 'vitest';

import { type GooglePlace } from '../google-places.type';
import { mapPlaceToLead } from '../map-place-to-lead';

const COLLECTED_AT = '2026-08-07T10:00:00.000Z';

const place: GooglePlace = {
  id: 'ChIJ-place-1',
  displayName: { text: 'Zahnarztpraxis Meier' },
  formattedAddress: 'Leopoldstr. 12, 80802 München, Germany',
  addressComponents: [
    { longText: '12', types: ['street_number'] },
    { longText: 'Leopoldstraße', types: ['route'] },
    { longText: 'München', types: ['locality'] },
    { longText: 'Bayern', types: ['administrative_area_level_1'] },
    { longText: '80802', types: ['postal_code'] },
    { longText: 'Germany', shortText: 'DE', types: ['country'] },
  ],
  websiteUri: 'https://www.zahnarzt-meier.de/praxis',
  internationalPhoneNumber: '+49 89 123456',
  primaryType: 'dentist',
};

describe('mapPlaceToLead', () => {
  it('should map the core business fields', () => {
    const lead = mapPlaceToLead(place, COLLECTED_AT);

    expect(lead).not.toBeNull();
    expect(lead?.name).toBe('Zahnarztpraxis Meier');
    expect(lead?.domain).toBe('zahnarzt-meier.de');
    expect(lead?.category).toBe('dentist');
  });

  it('should record provenance', () => {
    const lead = mapPlaceToLead(place, COLLECTED_AT);

    expect(lead?.sourceProvider).toBe('GOOGLE_PLACES');
    expect(lead?.sourceExternalId).toBe('ChIJ-place-1');
    expect(lead?.sourceUrl).toBe('https://www.zahnarzt-meier.de/praxis');
    expect(lead?.collectedAt).toBe(COLLECTED_AT);
    expect(lead?.legalBasis).toBe('LEGITIMATE_INTEREST');
    expect(lead?.status).toBe('NEW');
  });

  it('should map the address components', () => {
    const lead = mapPlaceToLead(place, COLLECTED_AT);

    expect(lead?.address).toEqual({
      addressStreet1: 'Leopoldstraße 12',
      addressStreet2: '',
      addressCity: 'München',
      addressState: 'Bayern',
      addressPostcode: '80802',
      addressCountry: 'Germany',
    });
  });

  it('should map the phone into the Twenty composite shape', () => {
    const lead = mapPlaceToLead(place, COLLECTED_AT);

    expect(lead?.phones).toEqual({
      primaryPhoneCallingCode: '+49',
      primaryPhoneNumber: '89123456',
      additionalPhones: [],
    });
  });

  it('should map the website into the LINKS shape', () => {
    const lead = mapPlaceToLead(place, COLLECTED_AT);

    expect(lead?.website).toEqual({
      primaryLinkUrl: 'https://www.zahnarzt-meier.de/praxis',
      primaryLinkLabel: 'zahnarzt-meier.de',
      secondaryLinks: [],
    });
  });

  it('should return null when the place has no website', () => {
    expect(mapPlaceToLead({ ...place, websiteUri: undefined }, COLLECTED_AT)).toBeNull();
  });

  it('should return null when the website does not yield a domain', () => {
    expect(mapPlaceToLead({ ...place, websiteUri: 'garbage' }, COLLECTED_AT)).toBeNull();
  });

  it('should fall back to the place id when displayName is missing', () => {
    const lead = mapPlaceToLead({ ...place, displayName: undefined }, COLLECTED_AT);

    expect(lead?.name).toBe('ChIJ-place-1');
  });

  it('should omit phones when the place has no phone number', () => {
    const lead = mapPlaceToLead(
      { ...place, internationalPhoneNumber: undefined },
      COLLECTED_AT,
    );

    expect(lead?.phones).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../map-place-to-lead`.

- [ ] **Step 7: Write the mapper**

```ts
// src/lib/sources/google-places/map-place-to-lead.ts
import { normalizeDomain } from '../../dedupe/normalize-domain';
import { type GooglePlace, type GooglePlaceAddressComponent } from './google-places.type';
import { parsePhone, type TwentyPhones } from './parse-phone';

export type LeadAddress = {
  addressStreet1: string;
  addressStreet2: string;
  addressCity: string;
  addressState: string;
  addressPostcode: string;
  addressCountry: string;
};

export type LeadInput = {
  name: string;
  domain: string;
  website: {
    primaryLinkUrl: string;
    primaryLinkLabel: string;
    secondaryLinks: never[];
  };
  phones?: TwentyPhones;
  address: LeadAddress;
  category: string;
  status: 'NEW';
  sourceProvider: 'GOOGLE_PLACES';
  sourceExternalId: string;
  sourceUrl: string;
  collectedAt: string;
  legalBasis: 'LEGITIMATE_INTEREST';
};

const componentText = (
  components: GooglePlaceAddressComponent[] | undefined,
  type: string,
): string =>
  components?.find((component) => component.types.includes(type))?.longText ?? '';

export const mapPlaceToLead = (
  place: GooglePlace,
  collectedAt: string,
): LeadInput | null => {
  // No website means no dedupe key and nothing to research. Skip.
  const domain = normalizeDomain(place.websiteUri);

  if (domain === null || place.websiteUri === undefined) {
    return null;
  }

  const components = place.addressComponents;
  const route = componentText(components, 'route');
  const streetNumber = componentText(components, 'street_number');
  const phones = parsePhone(place.internationalPhoneNumber);

  const lead: LeadInput = {
    name: place.displayName?.text ?? place.id,
    domain,
    website: {
      primaryLinkUrl: place.websiteUri,
      primaryLinkLabel: domain,
      secondaryLinks: [],
    },
    address: {
      addressStreet1: [route, streetNumber].filter((part) => part !== '').join(' '),
      addressStreet2: '',
      addressCity: componentText(components, 'locality'),
      addressState: componentText(components, 'administrative_area_level_1'),
      addressPostcode: componentText(components, 'postal_code'),
      addressCountry: componentText(components, 'country'),
    },
    category: place.primaryType ?? '',
    status: 'NEW',
    sourceProvider: 'GOOGLE_PLACES',
    sourceExternalId: place.id,
    sourceUrl: place.websiteUri,
    collectedAt,
    legalBasis: 'LEGITIMATE_INTEREST',
  };

  if (phones !== null) {
    lead.phones = phones;
  }

  return lead;
};
```

- [ ] **Step 8: Run it to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 13 tests across both files.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: map Google Places results to Lead inputs with provenance"
```

---

### Task 8: Existing-lead and suppression lookups

**Files:**
- Create: `src/lib/dedupe/lead-lookup.ts`
- Test: `src/lib/dedupe/__tests__/lead-lookup.test.ts`

**Interfaces:**
- Consumes: the generated `CoreApiClient` from Task 3's sync.
- Produces: `findExistingLeadDomains(client, domains): Promise<Set<string>>` and `findSuppressedDomains(client, domains): Promise<Set<string>>`. Task 9 calls both, once per page, with all twenty domains at once.

Batch lookups, not per-record. One page is twenty places; twenty sequential round trips per page would dominate the run time.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/dedupe/__tests__/lead-lookup.test.ts
import { describe, expect, it, vi } from 'vitest';

import { findExistingLeadDomains, findSuppressedDomains } from '../lead-lookup';

const clientWith = (result: unknown) => ({ query: vi.fn().mockResolvedValue(result) });

describe('findExistingLeadDomains', () => {
  it('should return the set of domains that already exist', async () => {
    const client = clientWith({
      leads: {
        edges: [{ node: { domain: 'a.de' } }, { node: { domain: 'b.de' } }],
      },
    });

    const existing = await findExistingLeadDomains(client as never, ['a.de', 'b.de', 'c.de']);

    expect(existing).toEqual(new Set(['a.de', 'b.de']));
  });

  it('should filter by the requested domains', async () => {
    const client = clientWith({ leads: { edges: [] } });

    await findExistingLeadDomains(client as never, ['a.de', 'b.de']);

    expect(client.query).toHaveBeenCalledWith({
      leads: {
        __args: { filter: { domain: { in: ['a.de', 'b.de'] } }, first: 2 },
        edges: { node: { domain: true } },
      },
    });
  });

  it('should short-circuit without querying when given no domains', async () => {
    const client = clientWith({ leads: { edges: [] } });

    const existing = await findExistingLeadDomains(client as never, []);

    expect(existing).toEqual(new Set());
    expect(client.query).not.toHaveBeenCalled();
  });

  it('should tolerate a missing edges array', async () => {
    const client = clientWith({ leads: {} });

    expect(await findExistingLeadDomains(client as never, ['a.de'])).toEqual(new Set());
  });
});

describe('findSuppressedDomains', () => {
  it('should return the set of suppressed domains', async () => {
    const client = clientWith({
      leadSuppressions: { edges: [{ node: { domain: 'blocked.de' } }] },
    });

    const suppressed = await findSuppressedDomains(client as never, ['blocked.de', 'ok.de']);

    expect(suppressed).toEqual(new Set(['blocked.de']));
  });

  it('should short-circuit without querying when given no domains', async () => {
    const client = clientWith({ leadSuppressions: { edges: [] } });

    expect(await findSuppressedDomains(client as never, [])).toEqual(new Set());
    expect(client.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../lead-lookup`.

- [ ] **Step 3: Write the lookups**

```ts
// src/lib/dedupe/lead-lookup.ts
import { type CoreApiClient } from 'twenty-client-sdk/core';

type DomainEdges = { edges?: { node: { domain?: string | null } }[] };

const toDomainSet = (connection: DomainEdges | undefined): Set<string> =>
  new Set(
    (connection?.edges ?? [])
      .map((edge) => edge.node.domain)
      .filter((domain): domain is string => typeof domain === 'string'),
  );

// Batched on purpose: one page is twenty places, and twenty sequential
// lookups per page would dominate the run.
export const findExistingLeadDomains = async (
  client: CoreApiClient,
  domains: string[],
): Promise<Set<string>> => {
  if (domains.length === 0) {
    return new Set();
  }

  const result = (await client.query({
    leads: {
      __args: { filter: { domain: { in: domains } }, first: domains.length },
      edges: { node: { domain: true } },
    },
  })) as { leads?: DomainEdges };

  return toDomainSet(result.leads);
};

export const findSuppressedDomains = async (
  client: CoreApiClient,
  domains: string[],
): Promise<Set<string>> => {
  if (domains.length === 0) {
    return new Set();
  }

  const result = (await client.query({
    leadSuppressions: {
      __args: { filter: { domain: { in: domains } }, first: domains.length },
      edges: { node: { domain: true } },
    },
  })) as { leadSuppressions?: DomainEdges };

  return toDomainSet(result.leadSuppressions);
};
```

- [ ] **Step 4: Run it to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck against the generated client**

```bash
yarn typecheck
```

Expected: exit 0. If `twenty-client-sdk/core` does not know the `leads` operation, Task 3's `yarn twenty apply` did not complete. Re-run it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add batched lead dedupe and suppression lookups"
```

---

### Task 9: The page function

**Files:**
- Create: `src/logic-functions/lead-search-page.logic-function.ts`
- Test: `src/logic-functions/__tests__/lead-search-page.test.ts`
- Modify: `src/constants/universal-identifiers.ts` (add three logic function UUIDs)

**Interfaces:**
- Consumes: `parseCriteria`, `expandCriteriaToQueries` (Task 4), `searchPlacesPage` (Task 6), `mapPlaceToLead` (Task 7), `findExistingLeadDomains`, `findSuppressedDomains` (Task 8).
- Produces: a logic function keyed by `LEAD_DISCOVERY_IDS.logicFunctions.leadSearchPage`, accepting `LeadSearchPagePayload`. Task 10 enqueues it.

This is the chunked chain from the background-jobs doc. One invocation handles exactly one Places page, then enqueues its own successor.

- [ ] **Step 1: Add the logic function UUIDs**

Generate three more and append to the constants:

```ts
  logicFunctions: {
    leadSearchPage: 'REPLACE-WITH-UUID-36',
    leadSearchRun: 'REPLACE-WITH-UUID-37',
    leadSearchScheduler: 'REPLACE-WITH-UUID-38',
  },
```

- [ ] **Step 2: Write the failing test**

```ts
// src/logic-functions/__tests__/lead-search-page.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, mutationMock, enqueueJobMock, searchPlacesPageMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  enqueueJobMock: vi.fn(),
  searchPlacesPageMock: vi.fn(),
}));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: vi.fn(function () {
    return { query: queryMock, mutation: mutationMock };
  }),
}));

vi.mock('twenty-sdk/logic-function', () => ({ enqueueJob: enqueueJobMock }));

vi.mock('../../lib/sources/google-places/google-places-client', () => ({
  searchPlacesPage: searchPlacesPageMock,
}));

import leadSearchPage from '../lead-search-page.logic-function';
import { type LeadSearchPagePayload } from '../lead-search-page.logic-function';

const handler = leadSearchPage.config.handler as (
  payload: LeadSearchPagePayload,
) => Promise<{ processed: number; created: number; done: boolean }>;

const CRITERIA = {
  categories: ['dentist'],
  locations: ['Munich, Germany'],
  keywords: [],
  requireWebsite: true,
  languageCode: 'de',
  regionCode: 'DE',
  maxPagesPerQuery: 3,
};

const payload: LeadSearchPagePayload = {
  leadSearchId: 'search-1',
  leadSearchRunId: 'run-1',
  queryIndex: 0,
  pageNumber: 1,
};

const placeWithDomain = (id: string, host: string) => ({
  id,
  displayName: { text: id },
  websiteUri: `https://${host}`,
  addressComponents: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';

  queryMock.mockImplementation(async (request: Record<string, unknown>) => {
    if ('leadSearch' in request) {
      return { leadSearch: { id: 'search-1', criteria: CRITERIA } };
    }

    if ('leadSearchRun' in request) {
      return {
        leadSearchRun: {
          resultCount: 0,
          newCount: 0,
          duplicateCount: 0,
          suppressedCount: 0,
        },
      };
    }

    if ('leads' in request) {
      return { leads: { edges: [] } };
    }

    return { leadSuppressions: { edges: [] } };
  });

  mutationMock.mockResolvedValue({});
});

describe('lead-search-page handler', () => {
  it('should create a lead for each new place', async () => {
    searchPlacesPageMock.mockResolvedValue({
      places: [placeWithDomain('p1', 'a.de'), placeWithDomain('p2', 'b.de')],
      nextPageToken: undefined,
    });

    const result = await handler(payload);

    expect(result.created).toBe(2);

    const createCalls = mutationMock.mock.calls.filter(
      (call) => 'createLead' in call[0],
    );

    expect(createCalls).toHaveLength(2);
  });

  it('should skip places whose domain already exists', async () => {
    queryMock.mockImplementation(async (request: Record<string, unknown>) => {
      if ('leadSearch' in request) {
        return { leadSearch: { id: 'search-1', criteria: CRITERIA } };
      }

      if ('leadSearchRun' in request) {
        return {
          leadSearchRun: {
            resultCount: 0,
            newCount: 0,
            duplicateCount: 0,
            suppressedCount: 0,
          },
        };
      }

      if ('leads' in request) {
        return { leads: { edges: [{ node: { domain: 'a.de' } }] } };
      }

      return { leadSuppressions: { edges: [] } };
    });

    searchPlacesPageMock.mockResolvedValue({
      places: [placeWithDomain('p1', 'a.de'), placeWithDomain('p2', 'b.de')],
    });

    const result = await handler(payload);

    expect(result.created).toBe(1);
  });

  it('should skip suppressed domains', async () => {
    queryMock.mockImplementation(async (request: Record<string, unknown>) => {
      if ('leadSearch' in request) {
        return { leadSearch: { id: 'search-1', criteria: CRITERIA } };
      }

      if ('leadSearchRun' in request) {
        return {
          leadSearchRun: {
            resultCount: 0,
            newCount: 0,
            duplicateCount: 0,
            suppressedCount: 0,
          },
        };
      }

      if ('leads' in request) {
        return { leads: { edges: [] } };
      }

      return { leadSuppressions: { edges: [{ node: { domain: 'a.de' } }] } };
    });

    searchPlacesPageMock.mockResolvedValue({
      places: [placeWithDomain('p1', 'a.de'), placeWithDomain('p2', 'b.de')],
    });

    const result = await handler(payload);

    expect(result.created).toBe(1);
  });

  it('should enqueue the next page when a token comes back', async () => {
    searchPlacesPageMock.mockResolvedValue({
      places: [placeWithDomain('p1', 'a.de')],
      nextPageToken: 'tok-2',
    });

    await handler(payload);

    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobMock.mock.calls[0][0].payload).toEqual({
      leadSearchId: 'search-1',
      leadSearchRunId: 'run-1',
      queryIndex: 0,
      pageToken: 'tok-2',
      pageNumber: 2,
    });
  });

  it('should advance to the next query when the page cap is reached', async () => {
    // Two locations means two queries, so advancing past query 0 has
    // somewhere to go instead of ending the run.
    queryMock.mockImplementation(async (request: Record<string, unknown>) => {
      if ('leadSearch' in request) {
        return {
          leadSearch: {
            id: 'search-1',
            criteria: { ...CRITERIA, locations: ['Munich, Germany', 'Berlin, Germany'] },
          },
        };
      }

      if ('leadSearchRun' in request) {
        return {
          leadSearchRun: {
            resultCount: 0,
            newCount: 0,
            duplicateCount: 0,
            suppressedCount: 0,
          },
        };
      }

      if ('leads' in request) {
        return { leads: { edges: [] } };
      }

      return { leadSuppressions: { edges: [] } };
    });

    searchPlacesPageMock.mockResolvedValue({
      places: [placeWithDomain('p1', 'a.de')],
      nextPageToken: 'tok-4',
    });

    await handler({ ...payload, pageNumber: 3 });

    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobMock.mock.calls[0][0].payload).toEqual({
      leadSearchId: 'search-1',
      leadSearchRunId: 'run-1',
      queryIndex: 1,
      pageNumber: 1,
    });
  });

  it('should finish the run when the last query is exhausted', async () => {
    searchPlacesPageMock.mockResolvedValue({ places: [], nextPageToken: undefined });

    const result = await handler({ ...payload, queryIndex: 0 });

    expect(result.done).toBe(true);
    expect(enqueueJobMock).not.toHaveBeenCalled();

    // Two updateLeadSearchRun mutations fire on this path: the counter
    // update, then the completion. Assert on the completion, not the first.
    const runUpdates = mutationMock.mock.calls.filter(
      (call) => 'updateLeadSearchRun' in call[0],
    );
    const completion = runUpdates[runUpdates.length - 1][0];

    expect(completion.updateLeadSearchRun.__args.data.status).toBe('COMPLETED');
    expect(completion.updateLeadSearchRun.__args.data.finishedAt).toEqual(
      expect.any(String),
    );
  });

  it('should mark the run failed and not enqueue when the API key is missing', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    await expect(handler(payload)).rejects.toThrow('GOOGLE_MAPS_API_KEY');

    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../lead-search-page.logic-function`.

- [ ] **Step 4: Write the page function**

```ts
// src/logic-functions/lead-search-page.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { enqueueJob } from 'twenty-sdk/logic-function';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';
import {
  expandCriteriaToQueries,
  parseCriteria,
} from '../lib/criteria/expand-criteria-to-queries';
import { findExistingLeadDomains, findSuppressedDomains } from '../lib/dedupe/lead-lookup';
import { searchPlacesPage } from '../lib/sources/google-places/google-places-client';
import { mapPlaceToLead } from '../lib/sources/google-places/map-place-to-lead';

export type LeadSearchPagePayload = {
  leadSearchId: string;
  leadSearchRunId: string;
  queryIndex: number;
  pageToken?: string;
  pageNumber: number;
};

// Paces the chain against the Places quota. One page per two seconds is
// far below any published limit and keeps a large matrix from spiking.
const PAGE_DELAY_MS = 2_000;

const handler = async (payload: LeadSearchPagePayload) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured on this app registration');
  }

  const client = new CoreApiClient();

  const searchResult = (await client.query({
    leadSearch: {
      __args: { filter: { id: { eq: payload.leadSearchId } } },
      id: true,
      criteria: true,
    },
  })) as { leadSearch?: { id: string; criteria: unknown } };

  if (!searchResult.leadSearch) {
    throw new Error(`Lead search ${payload.leadSearchId} not found`);
  }

  const criteria = parseCriteria(searchResult.leadSearch.criteria);
  const queries = expandCriteriaToQueries(criteria);

  const finishRun = async () => {
    await client.mutation({
      updateLeadSearchRun: {
        __args: {
          id: payload.leadSearchRunId,
          data: { status: 'COMPLETED', finishedAt: new Date().toISOString() },
        },
        id: true,
      },
    });
  };

  if (payload.queryIndex >= queries.length) {
    await finishRun();

    return { processed: 0, created: 0, done: true };
  }

  const page = await searchPlacesPage({
    apiKey,
    query: queries[payload.queryIndex],
    pageToken: payload.pageToken,
  });

  const collectedAt = new Date().toISOString();
  const candidates = page.places
    .map((place) => mapPlaceToLead(place, collectedAt))
    .filter((lead): lead is NonNullable<typeof lead> => lead !== null);

  const domains = candidates.map((lead) => lead.domain);
  const [existing, suppressed] = await Promise.all([
    findExistingLeadDomains(client, domains),
    findSuppressedDomains(client, domains),
  ]);

  let created = 0;
  let duplicates = 0;
  let suppressedSkipped = 0;
  const seenThisPage = new Set<string>();

  for (const lead of candidates) {
    if (suppressed.has(lead.domain)) {
      suppressedSkipped += 1;
      continue;
    }

    // seenThisPage guards against the same domain appearing twice within
    // one page, which the pre-fetched `existing` set cannot catch.
    if (existing.has(lead.domain) || seenThisPage.has(lead.domain)) {
      duplicates += 1;
      continue;
    }

    seenThisPage.add(lead.domain);

    await client.mutation({
      createLead: {
        __args: { data: { ...lead, leadSearchId: payload.leadSearchId } },
        id: true,
      },
    });

    created += 1;
  }

  const runResult = (await client.query({
    leadSearchRun: {
      __args: { filter: { id: { eq: payload.leadSearchRunId } } },
      resultCount: true,
      newCount: true,
      duplicateCount: true,
      suppressedCount: true,
    },
  })) as {
    leadSearchRun?: {
      resultCount: number;
      newCount: number;
      duplicateCount: number;
      suppressedCount: number;
    };
  };

  const totals = runResult.leadSearchRun ?? {
    resultCount: 0,
    newCount: 0,
    duplicateCount: 0,
    suppressedCount: 0,
  };

  await client.mutation({
    updateLeadSearchRun: {
      __args: {
        id: payload.leadSearchRunId,
        data: {
          resultCount: totals.resultCount + page.places.length,
          newCount: totals.newCount + created,
          duplicateCount: totals.duplicateCount + duplicates,
          suppressedCount: totals.suppressedCount + suppressedSkipped,
        },
      },
      id: true,
    },
  });

  const canPageFurther =
    page.nextPageToken !== undefined && payload.pageNumber < criteria.maxPagesPerQuery;

  const nextPayload: LeadSearchPagePayload = canPageFurther
    ? {
        leadSearchId: payload.leadSearchId,
        leadSearchRunId: payload.leadSearchRunId,
        queryIndex: payload.queryIndex,
        pageToken: page.nextPageToken,
        pageNumber: payload.pageNumber + 1,
      }
    : {
        leadSearchId: payload.leadSearchId,
        leadSearchRunId: payload.leadSearchRunId,
        queryIndex: payload.queryIndex + 1,
        pageNumber: 1,
      };

  if (nextPayload.queryIndex >= queries.length) {
    await finishRun();

    return { processed: page.places.length, created, done: true };
  }

  await enqueueJob({
    logicFunctionUniversalIdentifier: LEAD_DISCOVERY_IDS.logicFunctions.leadSearchPage,
    payload: nextPayload,
    delayMs: PAGE_DELAY_MS,
  });

  return { processed: page.places.length, created, done: false };
};

export default defineLogicFunction({
  universalIdentifier: LEAD_DISCOVERY_IDS.logicFunctions.leadSearchPage,
  name: 'lead-search-page',
  description:
    'Processes one page of one query in a lead search run, then enqueues the next page.',
  timeoutSeconds: 120,
  handler,
});
```

`retryLimit` stays at the default `0`. The handler creates records, and a mid-page retry would re-run the creates for domains already written in the failed attempt. Making it retry-safe is a follow-up, not a phase-1 requirement.

- [ ] **Step 5: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Typecheck**

```bash
yarn typecheck
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add chunked lead search page function"
```

---

### Task 10: The run function

**Files:**
- Create: `src/logic-functions/lead-search-run.logic-function.ts`
- Test: `src/logic-functions/__tests__/lead-search-run.test.ts`

**Interfaces:**
- Consumes: `LEAD_DISCOVERY_IDS.logicFunctions.leadSearchPage` (Task 9).
- Produces: a logic function accepting `{ leadSearchId: string }`, exposed as an AI tool and a workflow action. Task 11 enqueues it.

- [ ] **Step 1: Write the failing test**

```ts
// src/logic-functions/__tests__/lead-search-run.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutationMock, enqueueJobMock } = vi.hoisted(() => ({
  mutationMock: vi.fn(),
  enqueueJobMock: vi.fn(),
}));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: vi.fn(function () {
    return { mutation: mutationMock };
  }),
}));

// lead-search-run also imports jsonSchemaToInputSchema, which runs at
// module load. A factory that only returns enqueueJob would make it
// undefined and the import would throw before any test runs.
vi.mock('twenty-sdk/logic-function', () => ({
  enqueueJob: enqueueJobMock,
  jsonSchemaToInputSchema: (schema: unknown) => schema,
}));

import leadSearchRun from '../lead-search-run.logic-function';

const handler = leadSearchRun.config.handler as (payload: {
  leadSearchId: string;
}) => Promise<{ leadSearchRunId: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  mutationMock.mockResolvedValue({ createLeadSearchRun: { id: 'run-42' } });
});

describe('lead-search-run handler', () => {
  it('should create a run in RUNNING state', async () => {
    await handler({ leadSearchId: 'search-1' });

    const data = mutationMock.mock.calls[0][0].createLeadSearchRun.__args.data;

    expect(data.status).toBe('RUNNING');
    expect(data.leadSearchId).toBe('search-1');
    expect(typeof data.startedAt).toBe('string');
  });

  it('should return the new run id', async () => {
    const result = await handler({ leadSearchId: 'search-1' });

    expect(result.leadSearchRunId).toBe('run-42');
  });

  it('should enqueue the first page of the first query', async () => {
    await handler({ leadSearchId: 'search-1' });

    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobMock.mock.calls[0][0].payload).toEqual({
      leadSearchId: 'search-1',
      leadSearchRunId: 'run-42',
      queryIndex: 0,
      pageNumber: 1,
    });
  });

  it('should reject a missing leadSearchId', async () => {
    await expect(handler({ leadSearchId: '' })).rejects.toThrow('leadSearchId is required');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../lead-search-run.logic-function`.

- [ ] **Step 3: Write the run function**

```ts
// src/logic-functions/lead-search-run.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import {
  enqueueJob,
  jsonSchemaToInputSchema,
  type InputJsonSchema,
} from 'twenty-sdk/logic-function';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

const inputSchema: InputJsonSchema = {
  type: 'object',
  properties: {
    leadSearchId: {
      type: 'string',
      label: 'Lead Search',
      description: 'Id of the LeadSearch record whose criteria should be run',
    },
  },
  required: ['leadSearchId'],
};

const handler = async (payload: { leadSearchId: string }) => {
  if (!payload.leadSearchId) {
    throw new Error('leadSearchId is required');
  }

  const client = new CoreApiClient();

  const created = (await client.mutation({
    createLeadSearchRun: {
      __args: {
        data: {
          name: `Run ${new Date().toISOString()}`,
          status: 'RUNNING',
          startedAt: new Date().toISOString(),
          leadSearchId: payload.leadSearchId,
        },
      },
      id: true,
    },
  })) as { createLeadSearchRun: { id: string } };

  const leadSearchRunId = created.createLeadSearchRun.id;

  await enqueueJob({
    logicFunctionUniversalIdentifier: LEAD_DISCOVERY_IDS.logicFunctions.leadSearchPage,
    payload: {
      leadSearchId: payload.leadSearchId,
      leadSearchRunId,
      queryIndex: 0,
      pageNumber: 1,
    },
  });

  return { leadSearchRunId };
};

export default defineLogicFunction({
  universalIdentifier: LEAD_DISCOVERY_IDS.logicFunctions.leadSearchRun,
  name: 'lead-search-run',
  description:
    'Starts a lead discovery run for a saved LeadSearch. Creates a run record and processes the full query matrix in the background. Use when the user asks to find new leads matching a saved search.',
  timeoutSeconds: 30,
  handler,
  toolTriggerSettings: { inputSchema },
  workflowActionTriggerSettings: {
    label: 'Run Lead Search',
    icon: 'IconZoomScan',
    inputSchema: jsonSchemaToInputSchema(inputSchema),
    outputSchema: [
      { type: 'object', properties: { leadSearchRunId: { type: 'string' } } },
    ],
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Sync and smoke-test against the local server**

Confirm `GOOGLE_MAPS_API_KEY` is set at **Settings → Admin Panel → Apps → Lead Discovery** (Task 1, Step 7), then:

```bash
yarn twenty apply
```

Create a LeadSearch record in the UI with this `criteria` JSON:

```json
{
  "categories": ["dentist"],
  "locations": ["Munich, Germany"],
  "maxPagesPerQuery": 1
}
```

Then run it, substituting the record id:

```bash
yarn twenty dev:function:exec -n lead-search-run -p '{"leadSearchId":"PASTE-RECORD-ID"}'
yarn twenty dev:function:logs
```

Expected: a LeadSearchRun record appears, and within a few seconds Lead records with populated `domain`, `address`, and `sourceExternalId` show up in the Leads table. The run flips to COMPLETED.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add lead search run function as tool and workflow action"
```

---

### Task 11: The scheduler

**Files:**
- Create: `src/logic-functions/lead-search-scheduler.logic-function.ts`
- Test: `src/logic-functions/__tests__/lead-search-scheduler.test.ts`

**Interfaces:**
- Consumes: `LEAD_DISCOVERY_IDS.logicFunctions.leadSearchRun` (Task 10).
- Produces: a cron-triggered logic function taking no payload.

- [ ] **Step 1: Write the failing test**

```ts
// src/logic-functions/__tests__/lead-search-scheduler.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, enqueueJobMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  enqueueJobMock: vi.fn(),
}));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: vi.fn(function () {
    return { query: queryMock };
  }),
}));

vi.mock('twenty-sdk/logic-function', () => ({ enqueueJob: enqueueJobMock }));

import leadSearchScheduler from '../lead-search-scheduler.logic-function';

const handler = leadSearchScheduler.config.handler as () => Promise<{ scheduled: number }>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lead-search-scheduler handler', () => {
  it('should enqueue a run for every active search', async () => {
    queryMock.mockResolvedValue({
      leadSearches: {
        edges: [{ node: { id: 'search-1' } }, { node: { id: 'search-2' } }],
      },
    });

    const result = await handler();

    expect(result.scheduled).toBe(2);
    expect(enqueueJobMock).toHaveBeenCalledTimes(2);
    expect(enqueueJobMock.mock.calls[0][0].payload).toEqual({ leadSearchId: 'search-1' });
  });

  it('should filter to active searches only', async () => {
    queryMock.mockResolvedValue({ leadSearches: { edges: [] } });

    await handler();

    expect(queryMock.mock.calls[0][0].leadSearches.__args.filter).toEqual({
      isActive: { eq: true },
    });
  });

  it('should do nothing when no search is active', async () => {
    queryMock.mockResolvedValue({ leadSearches: { edges: [] } });

    const result = await handler();

    expect(result.scheduled).toBe(0);
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../lead-search-scheduler.logic-function`.

- [ ] **Step 3: Write the scheduler**

```ts
// src/logic-functions/lead-search-scheduler.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { enqueueJob } from 'twenty-sdk/logic-function';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

// 03:00 every Monday. Weekly is the right cadence for local business
// listings — they change slowly, and each run costs real Places quota.
const WEEKLY_MONDAY_3AM = '0 3 * * 1';

const MAX_SEARCHES_PER_TICK = 50;

const handler = async () => {
  const client = new CoreApiClient();

  const result = (await client.query({
    leadSearches: {
      __args: { filter: { isActive: { eq: true } }, first: MAX_SEARCHES_PER_TICK },
      edges: { node: { id: true } },
    },
  })) as { leadSearches?: { edges?: { node: { id: string } }[] } };

  const searches = result.leadSearches?.edges ?? [];

  for (const edge of searches) {
    await enqueueJob({
      logicFunctionUniversalIdentifier: LEAD_DISCOVERY_IDS.logicFunctions.leadSearchRun,
      payload: { leadSearchId: edge.node.id },
    });
  }

  return { scheduled: searches.length };
};

export default defineLogicFunction({
  universalIdentifier: LEAD_DISCOVERY_IDS.logicFunctions.leadSearchScheduler,
  name: 'lead-search-scheduler',
  description: 'Weekly tick that starts a run for every active lead search.',
  timeoutSeconds: 60,
  handler,
  cronTriggerSettings: { pattern: WEEKLY_MONDAY_3AM },
});
```

`MAX_SEARCHES_PER_TICK` is a deliberate cap. If a workspace ever has more than fifty active searches, the extras are silently skipped — revisit with pagination at that point.

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add weekly lead search scheduler"
```

---

### Task 12: Leads view and navigation

**Files:**
- Create: `src/views/leads.view.ts`
- Create: `src/navigation-menu-items/leads.navigation-menu-item.ts`
- Modify: `src/constants/universal-identifiers.ts` (add two UUIDs)

**Interfaces:**
- Consumes: `LEAD_DISCOVERY_IDS.leadObject` (Task 2).

- [ ] **Step 1: Add two UUIDs**

```ts
  views: { newLeads: 'REPLACE-WITH-UUID-39' },
  navigationMenuItems: { leads: 'REPLACE-WITH-UUID-40' },
```

- [ ] **Step 2: Write the view**

```ts
// src/views/leads.view.ts
import { defineView, ViewKey, ViewType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export default defineView({
  universalIdentifier: LEAD_DISCOVERY_IDS.views.newLeads,
  objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadObject,
  name: 'New Leads',
  icon: 'IconTargetArrow',
  type: ViewType.TABLE,
  key: ViewKey.INDEX,
});
```

- [ ] **Step 3: Write the navigation item**

```ts
// src/navigation-menu-items/leads.navigation-menu-item.ts
import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import { LEAD_DISCOVERY_IDS } from '../constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: LEAD_DISCOVERY_IDS.navigationMenuItems.leads,
  label: 'Leads',
  icon: 'IconTargetArrow',
  type: NavigationMenuItemType.OBJECT,
  objectUniversalIdentifier: LEAD_DISCOVERY_IDS.leadObject,
  position: 0,
});
```

- [ ] **Step 4: Sync and verify in the UI**

```bash
yarn twenty apply
```

Expected: a **Leads** entry appears in the sidebar and opens a table of discovered leads.

- [ ] **Step 5: Run the full check**

```bash
yarn lint && yarn typecheck && yarn test:unit
```

Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Leads view and sidebar navigation"
```

---

## Definition of done

- `yarn lint`, `yarn typecheck`, and `yarn test:unit` all pass.
- `yarn twenty apply` exits 0 against the local server.
- Creating a LeadSearch with valid criteria and running `lead-search-run` produces Lead records with populated `domain`, `address`, `sourceExternalId`, `collectedAt`, and `legalBasis`.
- Running the same search twice produces zero new leads on the second pass, and the run's `duplicateCount` reflects the skips.
- Adding a domain to LeadSuppression prevents that domain being re-added on the next run, and `suppressedCount` reflects it.

## Follow-up plans

1. **Impressum enrichment** — crawl the lead's website for the legally required contact page and fill `emails`. This is what turns a directory listing into a usable lead, and for German B2B it is the highest-quality source available.
2. **Promotion** — reviewed conversion of Lead into Company and Person.
3. **Criteria builder front component** — replace hand-written JSON with a real UI.
4. **Exa source adapter** — semantic search alongside categorical Places search.
5. **Art. 14 notice tracking** — the `art14NoticeSentAt` and opt-out fields, needed before any outreach.

## Legal checkpoint before follow-up 5

The two questions from `docs/apps-roadmap.md` are still open and they gate outreach, not discovery:

- Which markets does this target? Germany only, DACH, or wider?
- Given UWG §7(2), is cold email viable, or does this feed manual and phone outreach?

Nothing in this plan depends on the answers. Discovery, deduplication, and provenance are identical either way. Get the answers before building anything that contacts a lead.

