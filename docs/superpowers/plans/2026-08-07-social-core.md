# Social Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The platform-agnostic foundation for social publishing: the object model, the publisher adapter contract, and the scheduling and fan-out engine, proven end to end with a dry-run adapter that needs no platform approval.

**Architecture:** One Twenty app, `twenty-social`. A `SocialPost` holds canonical content; a `SocialPostTarget` row per destination carries its own status, so a partial failure across four platforms is visible rather than mysterious. Publishing goes through a `SocialPublisher` interface resolved from a registry keyed by platform. This plan ships only the `DRY_RUN` implementation. Each platform plan adds one adapter and registers it, changing nothing else.

**Tech Stack:** TypeScript, `twenty-sdk` 2.23+, `twenty-client-sdk`, Vitest 4, oxlint.

## Global Constraints

- Node `^24.5.0`, Yarn 4 via Corepack, Docker for the local dev server.
- `twenty-sdk` and `twenty-client-sdk` in `devDependencies` only.
- Every `universalIdentifier` is a UUID v4, generated once, never changed.
- Literal string `defaultValue`s carry inner quotes: `"'DRAFT'"`, not `"DRAFT"`.
- Platform credentials are declared as `serverVariables` and entered by an admin at **Settings → Admin Panel → Apps**. Never in the manifest, never in git.
- Per-account access tokens live in the app key-value store, never in a record field. See "Where tokens live" below.
- `SocialPostTarget` is the unit of retry. Never retry a `SocialPost` as a whole.
- Adapters must not import each other. The registry is the only coupling point.

**Out of scope, each in its own plan:** the Facebook adapter and Lead Ads ingestion, the Instagram adapter, the LinkedIn adapter, the TikTok adapter, ad spend and metrics, and the composer front component.

---

## Where tokens live

Twenty's connection store (`getConnection` from `twenty-sdk/logic-function`) holds the OAuth credential for the *user* who connected. That is not the credential you publish with. Facebook publishes with a per-Page token, Instagram with a per-IG-user token, LinkedIn with an organization-scoped member token, TikTok with a per-creator token.

So there are two tiers, and this plan establishes the second:

| Tier | Holder | Set by |
|---|---|---|
| OAuth connection | Twenty, via `defineConnectionProvider` | The connect flow, per platform plan |
| Per-account publish token | App key-value store, key `token:{platform}:{externalId}` | The platform's `onConnect` hook |

The key-value store is isolated per app and per workspace, and no other app can read it. It is not encrypted at rest, which is an accepted tradeoff on a single-tenant self-hosted instance. Do not put tokens on a `SocialAccount` field, where they would be visible to anyone with read access to the object.

---

## File Structure

```text
twenty-social/
  src/
    application-config.ts
    roles/social.role.ts
    constants/universal-identifiers.ts
    objects/
      social-account.object.ts
      social-post.object.ts
      social-post-target.object.ts
    fields/                          Two relation pairs
    lib/
      publish/
        social-platform.ts           The platform enum, shared by every adapter
        publisher.type.ts            SocialPublisher contract
        publisher-registry.ts        platform -> adapter
        dry-run-publisher.ts         Ships in this plan
        validate-post-for-target.ts  Length and media rules, per platform
      accounts/
        account-token-store.ts       kv wrapper for per-account tokens
      fan-out/
        build-targets-for-post.ts    Post + accounts -> target rows
    logic-functions/
      publish-due-posts.logic-function.ts
      publish-target.logic-function.ts
    views/social-posts.view.ts
    navigation-menu-items/social-posts.navigation-menu-item.ts
```

---

### Task 1: Scaffold, role, and configuration

**Files:**
- Create: `twenty-social/` (via scaffolder)
- Modify: `src/application-config.ts`
- Create: `src/roles/social.role.ts`
- Create: `src/constants/universal-identifiers.ts`

**Interfaces:**
- Produces: `SOCIAL_IDS`, imported by every later task.

- [ ] **Step 1: Scaffold**

```bash
npx create-twenty-app@latest twenty-social \
  --display-name "Social" \
  --description "Schedule and publish posts across social platforms"
cd twenty-social
```

- [ ] **Step 2: Verify the dev loop**

```bash
yarn twenty dev
```

Expected: **Social** appears at http://localhost:2020/settings/applications#developer. Ctrl-C when confirmed.

- [ ] **Step 3: Generate UUIDs and write the constants**

```bash
for i in $(seq 1 34); do uuidgen | tr '[:upper:]' '[:lower:]'; done
```

```ts
// src/constants/universal-identifiers.ts
// Stable forever. Changing one drops and recreates the entity.
export const SOCIAL_IDS = {
  application: 'REPLACE-01',
  role: 'REPLACE-02',

  socialAccountObject: 'REPLACE-03',
  socialPostObject: 'REPLACE-04',
  socialPostTargetObject: 'REPLACE-05',

  socialAccountFields: {
    platform: 'REPLACE-06',
    externalId: 'REPLACE-07',
    handle: 'REPLACE-08',
    isActive: 'REPLACE-09',
    connectedAt: 'REPLACE-10',
    tokenExpiresAt: 'REPLACE-11',
  },

  socialPostFields: {
    body: 'REPLACE-12',
    mediaUrls: 'REPLACE-13',
    scheduledAt: 'REPLACE-14',
    status: 'REPLACE-15',
  },

  socialPostTargetFields: {
    platform: 'REPLACE-16',
    status: 'REPLACE-17',
    externalPostId: 'REPLACE-18',
    permalink: 'REPLACE-19',
    errorMessage: 'REPLACE-20',
    attemptCount: 'REPLACE-21',
    publishedAt: 'REPLACE-22',
  },

  relations: {
    targetsOnPost: 'REPLACE-23',
    postOnTarget: 'REPLACE-24',
    targetsOnAccount: 'REPLACE-25',
    accountOnTarget: 'REPLACE-26',
  },

  logicFunctions: {
    publishDuePosts: 'REPLACE-27',
    publishTarget: 'REPLACE-28',
  },

  views: { socialPosts: 'REPLACE-29' },
  navigationMenuItems: { socialPosts: 'REPLACE-30' },
} as const;
```

Slots 31 to 34 are spare. Platform plans append their own blocks.

- [ ] **Step 4: Write the role**

```ts
// src/roles/social.role.ts
import { defineApplicationRole } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineApplicationRole({
  universalIdentifier: SOCIAL_IDS.role,
  label: 'Social function role',
  description: 'Read and write Social records only',
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
      objectUniversalIdentifier: SOCIAL_IDS.socialAccountObject,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
    },
    {
      objectUniversalIdentifier: SOCIAL_IDS.socialPostObject,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
    },
    {
      objectUniversalIdentifier: SOCIAL_IDS.socialPostTargetObject,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
    },
  ],
  fieldPermissions: [],
});
```

- [ ] **Step 5: Write the application config**

```ts
// src/application-config.ts
import { defineApplication, FieldType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from './constants/universal-identifiers';

export default defineApplication({
  universalIdentifier: SOCIAL_IDS.application,
  displayName: 'Social',
  description:
    'Schedule and publish posts across social platforms, with per-channel status tracking.',
  // Platform credentials are appended here by each platform plan.
  // Admins enter values at Settings > Admin Panel > Apps.
  serverVariables: {
    SOCIAL_DRY_RUN: {
      description:
        'When true, every platform adapter is bypassed and posts are recorded as published without leaving the instance. Keep this on until a real platform adapter is approved and tested.',
      type: FieldType.BOOLEAN,
      isSecret: false,
      isRequired: false,
    },
  },
});
```

- [ ] **Step 6: Sync and set the dry-run flag**

```bash
yarn twenty apply
```

Then at **Settings → Admin Panel → Apps → Social**, set `SOCIAL_DRY_RUN` to true.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: scaffold social app with role and config"
```

---

### Task 2: SocialAccount object

**Files:**
- Create: `src/objects/social-account.object.ts`

**Interfaces:**
- Produces: `socialAccount` with `platform`, `externalId`, `handle`, `isActive`. `SocialPlatform` values are duplicated here as a SELECT because manifests cannot import from `src/lib`; Task 4 defines the canonical TypeScript enum and Task 4's test asserts the two agree.

- [ ] **Step 1: Write the object**

```ts
// src/objects/social-account.object.ts
import { defineObject, FieldType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineObject({
  universalIdentifier: SOCIAL_IDS.socialAccountObject,
  nameSingular: 'socialAccount',
  namePlural: 'socialAccounts',
  labelSingular: 'Social Account',
  labelPlural: 'Social Accounts',
  description: 'A connected page, profile, or creator account on a platform',
  icon: 'IconUserCircle',
  fields: [
    {
      universalIdentifier: SOCIAL_IDS.socialAccountFields.platform,
      name: 'platform',
      type: FieldType.SELECT,
      label: 'Platform',
      icon: 'IconWorld',
      defaultValue: "'DRY_RUN'",
      options: [
        { value: 'DRY_RUN', label: 'Dry run', position: 0, color: 'gray' },
        { value: 'FACEBOOK', label: 'Facebook', position: 1, color: 'blue' },
        { value: 'INSTAGRAM', label: 'Instagram', position: 2, color: 'purple' },
        { value: 'LINKEDIN', label: 'LinkedIn', position: 3, color: 'blue' },
        { value: 'TIKTOK', label: 'TikTok', position: 4, color: 'gray' },
      ],
    },
    {
      universalIdentifier: SOCIAL_IDS.socialAccountFields.externalId,
      name: 'externalId',
      type: FieldType.TEXT,
      label: 'External ID',
      description:
        'Platform identifier: Facebook page id, Instagram user id, LinkedIn organization URN, or TikTok open id',
      icon: 'IconFingerprint',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialAccountFields.handle,
      name: 'handle',
      type: FieldType.TEXT,
      label: 'Handle',
      icon: 'IconAt',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialAccountFields.isActive,
      name: 'isActive',
      type: FieldType.BOOLEAN,
      label: 'Active',
      description: 'Inactive accounts are skipped during fan-out',
      icon: 'IconToggleLeft',
      defaultValue: true,
    },
    {
      universalIdentifier: SOCIAL_IDS.socialAccountFields.connectedAt,
      name: 'connectedAt',
      type: FieldType.DATE_TIME,
      label: 'Connected at',
      icon: 'IconPlugConnected',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialAccountFields.tokenExpiresAt,
      name: 'tokenExpiresAt',
      type: FieldType.DATE_TIME,
      label: 'Token expires at',
      description: 'Null means the token does not expire, as with Facebook Page tokens',
      icon: 'IconClockExclamation',
    },
  ],
});
```

- [ ] **Step 2: Sync and verify**

```bash
yarn twenty apply
```

Expected: exit 0, and **Social Accounts** appears in Settings → Data model.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add SocialAccount object"
```

---

### Task 3: SocialPost, SocialPostTarget, and relations

**Files:**
- Create: `src/objects/social-post.object.ts`
- Create: `src/objects/social-post-target.object.ts`
- Create: `src/fields/targets-on-post.field.ts`
- Create: `src/fields/post-on-target.field.ts`
- Create: `src/fields/targets-on-account.field.ts`
- Create: `src/fields/account-on-target.field.ts`

**Interfaces:**
- Produces: `socialPost` with `body`, `mediaUrls`, `scheduledAt`, `status`; `socialPostTarget` with `status`, `attemptCount`, `externalPostId`, and relations to both parents. Tasks 5, 6, and 7 read and write these.

- [ ] **Step 1: Write SocialPost**

```ts
// src/objects/social-post.object.ts
import { defineObject, FieldType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export enum SocialPostStatus {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
  PUBLISHING = 'PUBLISHING',
  PUBLISHED = 'PUBLISHED',
  PARTIALLY_FAILED = 'PARTIALLY_FAILED',
  FAILED = 'FAILED',
}

export default defineObject({
  universalIdentifier: SOCIAL_IDS.socialPostObject,
  nameSingular: 'socialPost',
  namePlural: 'socialPosts',
  labelSingular: 'Social Post',
  labelPlural: 'Social Posts',
  description: 'Canonical post content, fanned out to one target per destination',
  icon: 'IconSpeakerphone',
  fields: [
    {
      universalIdentifier: SOCIAL_IDS.socialPostFields.body,
      name: 'body',
      type: FieldType.TEXT,
      label: 'Body',
      icon: 'IconAbc',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostFields.mediaUrls,
      name: 'mediaUrls',
      type: FieldType.ARRAY,
      label: 'Media URLs',
      description:
        'Publicly reachable URLs. Instagram and TikTok fetch media from these, so they must be accessible without auth.',
      icon: 'IconPhoto',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostFields.scheduledAt,
      name: 'scheduledAt',
      type: FieldType.DATE_TIME,
      label: 'Scheduled at',
      icon: 'IconCalendarClock',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostFields.status,
      name: 'status',
      type: FieldType.SELECT,
      label: 'Status',
      icon: 'IconProgressCheck',
      defaultValue: `'${SocialPostStatus.DRAFT}'`,
      options: [
        { value: SocialPostStatus.DRAFT, label: 'Draft', position: 0, color: 'gray' },
        { value: SocialPostStatus.SCHEDULED, label: 'Scheduled', position: 1, color: 'blue' },
        { value: SocialPostStatus.PUBLISHING, label: 'Publishing', position: 2, color: 'yellow' },
        { value: SocialPostStatus.PUBLISHED, label: 'Published', position: 3, color: 'green' },
        { value: SocialPostStatus.PARTIALLY_FAILED, label: 'Partially failed', position: 4, color: 'orange' },
        { value: SocialPostStatus.FAILED, label: 'Failed', position: 5, color: 'red' },
      ],
    },
  ],
});
```

- [ ] **Step 2: Write SocialPostTarget**

```ts
// src/objects/social-post-target.object.ts
import { defineObject, FieldType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export enum SocialPostTargetStatus {
  PENDING = 'PENDING',
  PUBLISHING = 'PUBLISHING',
  AWAITING_PLATFORM = 'AWAITING_PLATFORM',
  PUBLISHED = 'PUBLISHED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

export default defineObject({
  universalIdentifier: SOCIAL_IDS.socialPostTargetObject,
  nameSingular: 'socialPostTarget',
  namePlural: 'socialPostTargets',
  labelSingular: 'Social Post Target',
  labelPlural: 'Social Post Targets',
  description:
    'One post on one account. The unit of publishing and of retry, because a fan-out to four platforms fails partially all the time.',
  icon: 'IconTarget',
  fields: [
    {
      universalIdentifier: SOCIAL_IDS.socialPostTargetFields.platform,
      name: 'platform',
      type: FieldType.SELECT,
      label: 'Platform',
      icon: 'IconWorld',
      defaultValue: "'DRY_RUN'",
      options: [
        { value: 'DRY_RUN', label: 'Dry run', position: 0, color: 'gray' },
        { value: 'FACEBOOK', label: 'Facebook', position: 1, color: 'blue' },
        { value: 'INSTAGRAM', label: 'Instagram', position: 2, color: 'purple' },
        { value: 'LINKEDIN', label: 'LinkedIn', position: 3, color: 'blue' },
        { value: 'TIKTOK', label: 'TikTok', position: 4, color: 'gray' },
      ],
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostTargetFields.status,
      name: 'status',
      type: FieldType.SELECT,
      label: 'Status',
      icon: 'IconProgressCheck',
      defaultValue: `'${SocialPostTargetStatus.PENDING}'`,
      options: [
        { value: SocialPostTargetStatus.PENDING, label: 'Pending', position: 0, color: 'gray' },
        { value: SocialPostTargetStatus.PUBLISHING, label: 'Publishing', position: 1, color: 'yellow' },
        { value: SocialPostTargetStatus.AWAITING_PLATFORM, label: 'Awaiting platform', position: 2, color: 'yellow' },
        { value: SocialPostTargetStatus.PUBLISHED, label: 'Published', position: 3, color: 'green' },
        { value: SocialPostTargetStatus.FAILED, label: 'Failed', position: 4, color: 'red' },
        { value: SocialPostTargetStatus.SKIPPED, label: 'Skipped', position: 5, color: 'gray' },
      ],
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostTargetFields.externalPostId,
      name: 'externalPostId',
      type: FieldType.TEXT,
      label: 'External post ID',
      icon: 'IconFingerprint',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostTargetFields.permalink,
      name: 'permalink',
      type: FieldType.TEXT,
      label: 'Permalink',
      icon: 'IconExternalLink',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostTargetFields.errorMessage,
      name: 'errorMessage',
      type: FieldType.TEXT,
      label: 'Error',
      icon: 'IconAlertTriangle',
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostTargetFields.attemptCount,
      name: 'attemptCount',
      type: FieldType.NUMBER,
      label: 'Attempts',
      icon: 'IconRepeat',
      defaultValue: 0,
    },
    {
      universalIdentifier: SOCIAL_IDS.socialPostTargetFields.publishedAt,
      name: 'publishedAt',
      type: FieldType.DATE_TIME,
      label: 'Published at',
      icon: 'IconClockCheck',
    },
  ],
});
```

- [ ] **Step 3: Write the post-to-target relation pair**

```ts
// src/fields/targets-on-post.field.ts
import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineField({
  universalIdentifier: SOCIAL_IDS.relations.targetsOnPost,
  objectUniversalIdentifier: SOCIAL_IDS.socialPostObject,
  type: FieldType.RELATION,
  name: 'targets',
  label: 'Targets',
  icon: 'IconTarget',
  relationTargetObjectMetadataUniversalIdentifier: SOCIAL_IDS.socialPostTargetObject,
  relationTargetFieldMetadataUniversalIdentifier: SOCIAL_IDS.relations.postOnTarget,
  universalSettings: { relationType: RelationType.ONE_TO_MANY },
});
```

```ts
// src/fields/post-on-target.field.ts
import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineField({
  universalIdentifier: SOCIAL_IDS.relations.postOnTarget,
  objectUniversalIdentifier: SOCIAL_IDS.socialPostTargetObject,
  type: FieldType.RELATION,
  name: 'socialPost',
  label: 'Social Post',
  icon: 'IconSpeakerphone',
  relationTargetObjectMetadataUniversalIdentifier: SOCIAL_IDS.socialPostObject,
  relationTargetFieldMetadataUniversalIdentifier: SOCIAL_IDS.relations.targetsOnPost,
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
  },
});
```

- [ ] **Step 4: Write the account-to-target relation pair**

```ts
// src/fields/targets-on-account.field.ts
import { defineField, FieldType, RelationType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineField({
  universalIdentifier: SOCIAL_IDS.relations.targetsOnAccount,
  objectUniversalIdentifier: SOCIAL_IDS.socialAccountObject,
  type: FieldType.RELATION,
  name: 'targets',
  label: 'Targets',
  icon: 'IconTarget',
  relationTargetObjectMetadataUniversalIdentifier: SOCIAL_IDS.socialPostTargetObject,
  relationTargetFieldMetadataUniversalIdentifier: SOCIAL_IDS.relations.accountOnTarget,
  universalSettings: { relationType: RelationType.ONE_TO_MANY },
});
```

```ts
// src/fields/account-on-target.field.ts
import { defineField, FieldType, OnDeleteAction, RelationType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineField({
  universalIdentifier: SOCIAL_IDS.relations.accountOnTarget,
  objectUniversalIdentifier: SOCIAL_IDS.socialPostTargetObject,
  type: FieldType.RELATION,
  name: 'socialAccount',
  label: 'Social Account',
  icon: 'IconUserCircle',
  relationTargetObjectMetadataUniversalIdentifier: SOCIAL_IDS.socialAccountObject,
  relationTargetFieldMetadataUniversalIdentifier: SOCIAL_IDS.relations.targetsOnAccount,
  universalSettings: {
    relationType: RelationType.MANY_TO_ONE,
    onDelete: OnDeleteAction.CASCADE,
  },
});
```

- [ ] **Step 5: Sync and regenerate the typed client**

```bash
yarn twenty apply
```

Expected: exit 0. Tasks 5 onward will not typecheck until this succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add SocialPost, SocialPostTarget and relations"
```

---

### Task 4: Publisher contract, registry, and dry-run adapter

**Files:**
- Create: `src/lib/publish/social-platform.ts`
- Create: `src/lib/publish/publisher.type.ts`
- Create: `src/lib/publish/dry-run-publisher.ts`
- Create: `src/lib/publish/publisher-registry.ts`
- Test: `src/lib/publish/__tests__/publisher-registry.test.ts`

**Interfaces:**
- Produces: `SocialPlatform` (enum), `type PublishInput`, `type PublishResult`, `type SocialPublisher`, `registerPublisher(publisher)`, `getPublisher(platform)`, `dryRunPublisher`. Every platform plan implements `SocialPublisher` and calls `registerPublisher`.

This is the seam. Get it right and each platform plan is a single file plus one registration line.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/__tests__/publisher-registry.test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import { dryRunPublisher } from '../dry-run-publisher';
import { getPublisher, listRegisteredPlatforms, registerPublisher, resetRegistry } from '../publisher-registry';
import { SocialPlatform } from '../social-platform';
import { type SocialPublisher } from '../publisher.type';

const fakePublisher: SocialPublisher = {
  platform: SocialPlatform.FACEBOOK,
  maxBodyLength: 100,
  requiresMedia: false,
  publish: async () => ({ status: 'PUBLISHED', externalPostId: 'x' }),
};

beforeEach(() => {
  resetRegistry();
});

describe('publisher registry', () => {
  it('should return a registered publisher by platform', () => {
    registerPublisher(fakePublisher);

    expect(getPublisher(SocialPlatform.FACEBOOK)).toBe(fakePublisher);
  });

  it('should throw a clear error for an unregistered platform', () => {
    expect(() => getPublisher(SocialPlatform.TIKTOK)).toThrow(
      'No publisher registered for platform TIKTOK',
    );
  });

  it('should reject a second registration for the same platform', () => {
    registerPublisher(fakePublisher);

    expect(() => registerPublisher(fakePublisher)).toThrow(
      'A publisher is already registered for platform FACEBOOK',
    );
  });

  it('should list registered platforms', () => {
    registerPublisher(fakePublisher);

    expect(listRegisteredPlatforms()).toEqual([SocialPlatform.FACEBOOK]);
  });
});

describe('dryRunPublisher', () => {
  it('should report the DRY_RUN platform', () => {
    expect(dryRunPublisher.platform).toBe(SocialPlatform.DRY_RUN);
  });

  it('should return a published result with a synthetic id', async () => {
    const result = await dryRunPublisher.publish({
      body: 'hello',
      mediaUrls: [],
      accountExternalId: 'acct-1',
      accessToken: 'tok',
    });

    expect(result.status).toBe('PUBLISHED');
    expect(result.status === 'PUBLISHED' && result.externalPostId).toMatch(/^dry-run-/);
  });

  it('should never make a network call', async () => {
    // fetch is not stubbed here; a real call would reject in the test env.
    await expect(
      dryRunPublisher.publish({
        body: 'hello',
        mediaUrls: [],
        accountExternalId: 'acct-1',
        accessToken: 'tok',
      }),
    ).resolves.toMatchObject({ status: 'PUBLISHED' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../social-platform`.

- [ ] **Step 3: Write the platform enum**

```ts
// src/lib/publish/social-platform.ts

// Must stay in sync with the `platform` SELECT options on the
// socialAccount and socialPostTarget objects. Task 4's test in
// __tests__/platform-parity.test.ts asserts that.
export enum SocialPlatform {
  DRY_RUN = 'DRY_RUN',
  FACEBOOK = 'FACEBOOK',
  INSTAGRAM = 'INSTAGRAM',
  LINKEDIN = 'LINKEDIN',
  TIKTOK = 'TIKTOK',
}
```

- [ ] **Step 4: Write the publisher contract**

```ts
// src/lib/publish/publisher.type.ts
import { type SocialPlatform } from './social-platform';

export type PublishInput = {
  body: string;
  mediaUrls: string[];
  // Facebook page id, Instagram user id, LinkedIn organization URN,
  // TikTok open id. Whatever the platform addresses a destination by.
  accountExternalId: string;
  accessToken: string;
};

export type PublishResult =
  | { status: 'PUBLISHED'; externalPostId: string; permalink?: string }
  // Platforms that accept the post and finish it asynchronously, such as
  // TikTok's publish_id and Instagram's media container.
  | { status: 'AWAITING_PLATFORM'; externalPostId: string }
  | { status: 'FAILED'; error: string };

export type SocialPublisher = {
  platform: SocialPlatform;
  maxBodyLength: number;
  requiresMedia: boolean;
  publish(input: PublishInput): Promise<PublishResult>;
};
```

An adapter returns `FAILED` for an expected platform rejection and throws only for a bug. The caller in Task 6 treats a throw as a retryable fault and a `FAILED` result as final.

- [ ] **Step 5: Write the dry-run adapter**

```ts
// src/lib/publish/dry-run-publisher.ts
import { type PublishInput, type PublishResult, type SocialPublisher } from './publisher.type';
import { SocialPlatform } from './social-platform';

let counter = 0;

// Proves the whole engine without any platform approval. Keep it
// registered permanently — it is also the fixture every platform plan
// tests its fan-out against.
export const dryRunPublisher: SocialPublisher = {
  platform: SocialPlatform.DRY_RUN,
  maxBodyLength: 10_000,
  requiresMedia: false,
  publish: async (input: PublishInput): Promise<PublishResult> => {
    counter += 1;

    return {
      status: 'PUBLISHED',
      externalPostId: `dry-run-${input.accountExternalId}-${counter}`,
    };
  },
};
```

- [ ] **Step 6: Write the registry**

```ts
// src/lib/publish/publisher-registry.ts
import { dryRunPublisher } from './dry-run-publisher';
import { type SocialPublisher } from './publisher.type';
import { type SocialPlatform } from './social-platform';

const publishers = new Map<SocialPlatform, SocialPublisher>();

export const registerPublisher = (publisher: SocialPublisher): void => {
  if (publishers.has(publisher.platform)) {
    throw new Error(
      `A publisher is already registered for platform ${publisher.platform}`,
    );
  }

  publishers.set(publisher.platform, publisher);
};

export const getPublisher = (platform: SocialPlatform): SocialPublisher => {
  const publisher = publishers.get(platform);

  if (publisher === undefined) {
    throw new Error(`No publisher registered for platform ${platform}`);
  }

  return publisher;
};

export const listRegisteredPlatforms = (): SocialPlatform[] => [...publishers.keys()];

// Tests only. Production registration happens once at module load.
export const resetRegistry = (): void => {
  publishers.clear();
};

registerPublisher(dryRunPublisher);
```

The bottom-of-file registration means importing the registry is enough to get the dry-run adapter. Each platform plan appends one import and one `registerPublisher` call here.

- [ ] **Step 7: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 8 tests. Note `resetRegistry()` in `beforeEach` clears the dry-run registration, which is why the first test can register FACEBOOK cleanly.

- [ ] **Step 8: Write the parity test**

```ts
// src/lib/publish/__tests__/platform-parity.test.ts
import { describe, expect, it } from 'vitest';

import socialAccount from '../../../objects/social-account.object';
import socialPostTarget from '../../../objects/social-post-target.object';
import { SocialPlatform } from '../social-platform';

const optionValues = (object: { config: { fields?: { name: string; options?: { value: string }[] }[] } }) =>
  object.config.fields
    ?.find((field) => field.name === 'platform')
    ?.options?.map((option) => option.value) ?? [];

describe('platform enum parity', () => {
  it('should match the socialAccount platform options', () => {
    expect(optionValues(socialAccount).sort()).toEqual(Object.values(SocialPlatform).sort());
  });

  it('should match the socialPostTarget platform options', () => {
    expect(optionValues(socialPostTarget).sort()).toEqual(Object.values(SocialPlatform).sort());
  });
});
```

- [ ] **Step 9: Run it and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add publisher contract, registry and dry-run adapter"
```

Expected: PASS, 10 tests total.

---

### Task 5: Post validation and target fan-out

**Files:**
- Create: `src/lib/publish/validate-post-for-target.ts`
- Create: `src/lib/fan-out/build-targets-for-post.ts`
- Test: `src/lib/publish/__tests__/validate-post-for-target.test.ts`
- Test: `src/lib/fan-out/__tests__/build-targets-for-post.test.ts`

**Interfaces:**
- Consumes: `getPublisher` (Task 4).
- Produces: `validatePostForTarget({ body, mediaUrls, platform }): string | null` returning an error message or null, and `buildTargetsForPost({ post, accounts }): TargetPlan[]`. Task 6 calls the validator; Task 7 calls the builder.

- [ ] **Step 1: Write the failing validator test**

```ts
// src/lib/publish/__tests__/validate-post-for-target.test.ts
import { beforeEach, describe, expect, it } from 'vitest';

import { registerPublisher, resetRegistry } from '../publisher-registry';
import { SocialPlatform } from '../social-platform';
import { validatePostForTarget } from '../validate-post-for-target';

beforeEach(() => {
  resetRegistry();
  registerPublisher({
    platform: SocialPlatform.FACEBOOK,
    maxBodyLength: 20,
    requiresMedia: false,
    publish: async () => ({ status: 'PUBLISHED', externalPostId: 'x' }),
  });
  registerPublisher({
    platform: SocialPlatform.TIKTOK,
    maxBodyLength: 2200,
    requiresMedia: true,
    publish: async () => ({ status: 'PUBLISHED', externalPostId: 'x' }),
  });
});

describe('validatePostForTarget', () => {
  it('should return null for a valid post', () => {
    expect(
      validatePostForTarget({ body: 'short', mediaUrls: [], platform: SocialPlatform.FACEBOOK }),
    ).toBeNull();
  });

  it('should reject a body over the platform limit', () => {
    expect(
      validatePostForTarget({
        body: 'a'.repeat(21),
        mediaUrls: [],
        platform: SocialPlatform.FACEBOOK,
      }),
    ).toBe('Body is 21 characters, over the FACEBOOK limit of 20');
  });

  it('should reject an empty body when the platform needs no media', () => {
    expect(
      validatePostForTarget({ body: '   ', mediaUrls: [], platform: SocialPlatform.FACEBOOK }),
    ).toBe('Body is empty');
  });

  it('should reject a missing media url on a platform that requires media', () => {
    expect(
      validatePostForTarget({ body: 'caption', mediaUrls: [], platform: SocialPlatform.TIKTOK }),
    ).toBe('TIKTOK requires at least one media URL');
  });

  it('should accept an empty body when media is present and required', () => {
    expect(
      validatePostForTarget({
        body: '',
        mediaUrls: ['https://cdn.example.com/a.mp4'],
        platform: SocialPlatform.TIKTOK,
      }),
    ).toBeNull();
  });

  it('should reject a non-https media url', () => {
    expect(
      validatePostForTarget({
        body: 'caption',
        mediaUrls: ['http://cdn.example.com/a.mp4'],
        platform: SocialPlatform.TIKTOK,
      }),
    ).toBe('Media URLs must be https, got http://cdn.example.com/a.mp4');
  });

  it('should report the unregistered platform rather than throwing', () => {
    expect(
      validatePostForTarget({ body: 'x', mediaUrls: [], platform: SocialPlatform.LINKEDIN }),
    ).toBe('No publisher registered for platform LINKEDIN');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../validate-post-for-target`.

- [ ] **Step 3: Write the validator**

```ts
// src/lib/publish/validate-post-for-target.ts
import { getPublisher } from './publisher-registry';
import { type SocialPlatform } from './social-platform';

// Returns a human-readable reason the post cannot go to this platform,
// or null when it can. Never throws: an unregistered platform is a
// validation failure the operator should see on the target row, not a
// crash that loses the whole fan-out.
export const validatePostForTarget = ({
  body,
  mediaUrls,
  platform,
}: {
  body: string;
  mediaUrls: string[];
  platform: SocialPlatform;
}): string | null => {
  let publisher;

  try {
    publisher = getPublisher(platform);
  } catch (error) {
    return error instanceof Error ? error.message : `Unknown platform ${platform}`;
  }

  if (publisher.requiresMedia && mediaUrls.length === 0) {
    return `${platform} requires at least one media URL`;
  }

  if (!publisher.requiresMedia && body.trim() === '') {
    return 'Body is empty';
  }

  if (body.length > publisher.maxBodyLength) {
    return `Body is ${body.length} characters, over the ${platform} limit of ${publisher.maxBodyLength}`;
  }

  // Instagram and TikTok fetch media server-side and reject plain http.
  for (const url of mediaUrls) {
    if (!url.startsWith('https://')) {
      return `Media URLs must be https, got ${url}`;
    }
  }

  return null;
};
```

- [ ] **Step 4: Run it to verify it passes**

```bash
yarn test:unit
```

Expected: PASS.

- [ ] **Step 5: Write the failing fan-out test**

```ts
// src/lib/fan-out/__tests__/build-targets-for-post.test.ts
import { describe, expect, it } from 'vitest';

import { SocialPlatform } from '../../publish/social-platform';
import { buildTargetsForPost } from '../build-targets-for-post';

const accounts = [
  { id: 'acct-1', platform: SocialPlatform.FACEBOOK, isActive: true },
  { id: 'acct-2', platform: SocialPlatform.INSTAGRAM, isActive: true },
  { id: 'acct-3', platform: SocialPlatform.FACEBOOK, isActive: false },
];

describe('buildTargetsForPost', () => {
  it('should create one target per active account', () => {
    const targets = buildTargetsForPost({ postId: 'post-1', accounts });

    expect(targets).toEqual([
      {
        name: 'post-1 / FACEBOOK / acct-1',
        socialPostId: 'post-1',
        socialAccountId: 'acct-1',
        platform: SocialPlatform.FACEBOOK,
        status: 'PENDING',
        attemptCount: 0,
      },
      {
        name: 'post-1 / INSTAGRAM / acct-2',
        socialPostId: 'post-1',
        socialAccountId: 'acct-2',
        platform: SocialPlatform.INSTAGRAM,
        status: 'PENDING',
        attemptCount: 0,
      },
    ]);
  });

  it('should skip inactive accounts', () => {
    const targets = buildTargetsForPost({ postId: 'post-1', accounts });

    expect(targets.map((target) => target.socialAccountId)).not.toContain('acct-3');
  });

  it('should return an empty array when no account is active', () => {
    expect(
      buildTargetsForPost({
        postId: 'post-1',
        accounts: [{ id: 'a', platform: SocialPlatform.FACEBOOK, isActive: false }],
      }),
    ).toEqual([]);
  });

  it('should filter to the requested platforms when given', () => {
    const targets = buildTargetsForPost({
      postId: 'post-1',
      accounts,
      platforms: [SocialPlatform.INSTAGRAM],
    });

    expect(targets).toHaveLength(1);
    expect(targets[0].platform).toBe(SocialPlatform.INSTAGRAM);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../build-targets-for-post`.

- [ ] **Step 7: Write the builder**

```ts
// src/lib/fan-out/build-targets-for-post.ts
import { type SocialPlatform } from '../publish/social-platform';

export type FanOutAccount = {
  id: string;
  platform: SocialPlatform;
  isActive: boolean;
};

export type TargetPlan = {
  name: string;
  socialPostId: string;
  socialAccountId: string;
  platform: SocialPlatform;
  status: 'PENDING';
  attemptCount: 0;
};

export const buildTargetsForPost = ({
  postId,
  accounts,
  platforms,
}: {
  postId: string;
  accounts: FanOutAccount[];
  platforms?: SocialPlatform[];
}): TargetPlan[] =>
  accounts
    .filter((account) => account.isActive)
    .filter((account) => platforms === undefined || platforms.includes(account.platform))
    .map((account) => ({
      name: `${postId} / ${account.platform} / ${account.id}`,
      socialPostId: postId,
      socialAccountId: account.id,
      platform: account.platform,
      status: 'PENDING',
      attemptCount: 0,
    }));
```

- [ ] **Step 8: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add post validation and target fan-out"
```

Expected: PASS, 11 new tests.

---

### Task 6: The publish-target function

**Files:**
- Create: `src/lib/accounts/account-token-store.ts`
- Create: `src/logic-functions/publish-target.logic-function.ts`
- Test: `src/logic-functions/__tests__/publish-target.test.ts`

**Interfaces:**
- Consumes: `getPublisher`, `validatePostForTarget`, `SocialPlatform`.
- Produces: `getAccountToken(platform, externalId)` / `setAccountToken(...)`, and a logic function taking `{ socialPostTargetId: string }`. Task 7 enqueues it; every platform plan's `onConnect` hook calls `setAccountToken`.

- [ ] **Step 1: Write the token store**

```ts
// src/lib/accounts/account-token-store.ts
import { kv } from 'twenty-sdk/logic-function';

import { type SocialPlatform } from '../publish/social-platform';

// Per-account publish credentials. Deliberately not a record field:
// anyone with read access to socialAccount would otherwise see the token.
const tokenKey = (platform: SocialPlatform, externalId: string) =>
  `token:${platform}:${externalId}`;

export const setAccountToken = async (
  platform: SocialPlatform,
  externalId: string,
  token: string,
): Promise<void> => {
  await kv.set(tokenKey(platform, externalId), token);
};

export const getAccountToken = async (
  platform: SocialPlatform,
  externalId: string,
): Promise<string | null> => kv.get<string>(tokenKey(platform, externalId));

export const deleteAccountToken = async (
  platform: SocialPlatform,
  externalId: string,
): Promise<void> => {
  await kv.delete(tokenKey(platform, externalId));
};
```

- [ ] **Step 2: Write the failing test**

```ts
// src/logic-functions/__tests__/publish-target.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, mutationMock, kvGetMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  kvGetMock: vi.fn(),
}));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: vi.fn(function () {
    return { query: queryMock, mutation: mutationMock };
  }),
}));

vi.mock('twenty-sdk/logic-function', () => ({
  kv: { get: kvGetMock, set: vi.fn(), delete: vi.fn() },
  enqueueJob: vi.fn(),
}));

import publishTarget from '../publish-target.logic-function';

const handler = publishTarget.config.handler as (payload: {
  socialPostTargetId: string;
}) => Promise<{ status: string }>;

const target = {
  id: 'target-1',
  platform: 'DRY_RUN',
  attemptCount: 0,
  socialAccount: { externalId: 'acct-1' },
  socialPost: { body: 'hello world', mediaUrls: [] },
};

const dataOf = (name: string) =>
  mutationMock.mock.calls.find((call) => name in call[0])?.[0][name].__args.data;

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ socialPostTarget: target });
  mutationMock.mockResolvedValue({});
  kvGetMock.mockResolvedValue('token-abc');
});

describe('publish-target handler', () => {
  it('should publish through the dry-run adapter and record the external id', async () => {
    const result = await handler({ socialPostTargetId: 'target-1' });

    expect(result.status).toBe('PUBLISHED');

    const data = dataOf('updateSocialPostTarget');

    expect(data.status).toBe('PUBLISHED');
    expect(data.externalPostId).toMatch(/^dry-run-/);
    expect(data.publishedAt).toEqual(expect.any(String));
  });

  it('should increment the attempt count', async () => {
    await handler({ socialPostTargetId: 'target-1' });

    expect(dataOf('updateSocialPostTarget').attemptCount).toBe(1);
  });

  it('should fail the target when validation rejects the post', async () => {
    queryMock.mockResolvedValue({
      socialPostTarget: { ...target, socialPost: { body: '   ', mediaUrls: [] } },
    });

    const result = await handler({ socialPostTargetId: 'target-1' });

    expect(result.status).toBe('FAILED');
    expect(dataOf('updateSocialPostTarget').errorMessage).toBe('Body is empty');
  });

  it('should fail the target when no token is stored', async () => {
    kvGetMock.mockResolvedValue(null);

    const result = await handler({ socialPostTargetId: 'target-1' });

    expect(result.status).toBe('FAILED');
    expect(dataOf('updateSocialPostTarget').errorMessage).toContain('No stored token');
  });

  it('should not call the adapter when validation fails', async () => {
    queryMock.mockResolvedValue({
      socialPostTarget: { ...target, socialPost: { body: '', mediaUrls: [] } },
    });

    await handler({ socialPostTargetId: 'target-1' });

    expect(dataOf('updateSocialPostTarget').externalPostId).toBeUndefined();
  });

  it('should throw when the target does not exist', async () => {
    queryMock.mockResolvedValue({ socialPostTarget: null });

    await expect(handler({ socialPostTargetId: 'nope' })).rejects.toThrow(
      'Social post target nope not found',
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../publish-target.logic-function`.

- [ ] **Step 4: Write the function**

```ts
// src/logic-functions/publish-target.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';
import { getAccountToken } from '../lib/accounts/account-token-store';
import { getPublisher } from '../lib/publish/publisher-registry';
import { type SocialPlatform } from '../lib/publish/social-platform';
import { validatePostForTarget } from '../lib/publish/validate-post-for-target';

type TargetRecord = {
  id: string;
  platform: SocialPlatform;
  attemptCount: number;
  socialAccount: { externalId: string };
  socialPost: { body: string; mediaUrls: string[] | null };
};

const handler = async (payload: { socialPostTargetId: string }) => {
  const client = new CoreApiClient();

  const found = (await client.query({
    socialPostTarget: {
      __args: { filter: { id: { eq: payload.socialPostTargetId } } },
      id: true,
      platform: true,
      attemptCount: true,
      socialAccount: { externalId: true },
      socialPost: { body: true, mediaUrls: true },
    },
  })) as { socialPostTarget?: TargetRecord | null };

  const target = found.socialPostTarget;

  if (!target) {
    throw new Error(`Social post target ${payload.socialPostTargetId} not found`);
  }

  const attemptCount = target.attemptCount + 1;
  const body = target.socialPost.body ?? '';
  const mediaUrls = target.socialPost.mediaUrls ?? [];

  const fail = async (errorMessage: string) => {
    await client.mutation({
      updateSocialPostTarget: {
        __args: {
          id: target.id,
          data: { status: 'FAILED', errorMessage, attemptCount },
        },
        id: true,
      },
    });

    return { status: 'FAILED' as const };
  };

  const validationError = validatePostForTarget({
    body,
    mediaUrls,
    platform: target.platform,
  });

  if (validationError !== null) {
    return fail(validationError);
  }

  const accessToken = await getAccountToken(target.platform, target.socialAccount.externalId);

  if (accessToken === null) {
    return fail(
      `No stored token for ${target.platform} account ${target.socialAccount.externalId}. Reconnect the account.`,
    );
  }

  // A thrown error here is a bug or an outage: it propagates so the job
  // is recorded as failed and can be re-run. A FAILED result is the
  // platform saying no, which is final for this attempt.
  const result = await getPublisher(target.platform).publish({
    body,
    mediaUrls,
    accountExternalId: target.socialAccount.externalId,
    accessToken,
  });

  if (result.status === 'FAILED') {
    return fail(result.error);
  }

  await client.mutation({
    updateSocialPostTarget: {
      __args: {
        id: target.id,
        data: {
          status: result.status,
          externalPostId: result.externalPostId,
          attemptCount,
          errorMessage: null,
          ...(result.status === 'PUBLISHED'
            ? { publishedAt: new Date().toISOString(), permalink: result.permalink ?? null }
            : {}),
        },
      },
      id: true,
    },
  });

  return { status: result.status };
};

export default defineLogicFunction({
  universalIdentifier: SOCIAL_IDS.logicFunctions.publishTarget,
  name: 'publish-target',
  description: 'Publishes one social post target to its platform.',
  timeoutSeconds: 120,
  handler,
});
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add publish-target function and account token store"
```

---

### Task 7: The scheduler

**Files:**
- Create: `src/logic-functions/publish-due-posts.logic-function.ts`
- Test: `src/logic-functions/__tests__/publish-due-posts.test.ts`

**Interfaces:**
- Consumes: `buildTargetsForPost` (Task 5), `SOCIAL_IDS.logicFunctions.publishTarget` (Task 6).
- Produces: a cron logic function taking no payload.

- [ ] **Step 1: Write the failing test**

```ts
// src/logic-functions/__tests__/publish-due-posts.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, mutationMock, enqueueJobMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  enqueueJobMock: vi.fn(),
}));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: vi.fn(function () {
    return { query: queryMock, mutation: mutationMock };
  }),
}));

vi.mock('twenty-sdk/logic-function', () => ({
  enqueueJob: enqueueJobMock,
  kv: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
}));

import publishDuePosts from '../publish-due-posts.logic-function';

const handler = publishDuePosts.config.handler as () => Promise<{
  postsStarted: number;
  targetsCreated: number;
}>;

const duePost = { id: 'post-1', body: 'hello', mediaUrls: [], scheduledAt: '2026-01-01T00:00:00Z' };

const accounts = {
  edges: [
    { node: { id: 'acct-1', platform: 'DRY_RUN', isActive: true } },
    { node: { id: 'acct-2', platform: 'DRY_RUN', isActive: false } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();

  queryMock.mockImplementation(async (request: Record<string, unknown>) => {
    if ('socialPosts' in request) {
      return { socialPosts: { edges: [{ node: duePost }] } };
    }

    return { socialAccounts: accounts };
  });

  mutationMock.mockImplementation(async (request: Record<string, unknown>) => {
    if ('createSocialPostTarget' in request) {
      return { createSocialPostTarget: { id: 'target-new' } };
    }

    return {};
  });
});

describe('publish-due-posts handler', () => {
  it('should create a target for each active account', async () => {
    const result = await handler();

    expect(result.targetsCreated).toBe(1);

    const creates = mutationMock.mock.calls.filter((call) => 'createSocialPostTarget' in call[0]);

    expect(creates).toHaveLength(1);
    expect(creates[0][0].createSocialPostTarget.__args.data.socialAccountId).toBe('acct-1');
  });

  it('should enqueue publish-target for each created target', async () => {
    await handler();

    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobMock.mock.calls[0][0].payload).toEqual({
      socialPostTargetId: 'target-new',
    });
  });

  it('should move the post to PUBLISHING', async () => {
    await handler();

    const update = mutationMock.mock.calls.find((call) => 'updateSocialPost' in call[0]);

    expect(update?.[0].updateSocialPost.__args.data.status).toBe('PUBLISHING');
  });

  it('should filter to scheduled posts that are due', async () => {
    await handler();

    const filter = queryMock.mock.calls[0][0].socialPosts.__args.filter;

    expect(filter.status).toEqual({ eq: 'SCHEDULED' });
    expect(filter.scheduledAt.lte).toEqual(expect.any(String));
  });

  it('should mark a post FAILED when it has no active account', async () => {
    queryMock.mockImplementation(async (request: Record<string, unknown>) => {
      if ('socialPosts' in request) {
        return { socialPosts: { edges: [{ node: duePost }] } };
      }

      return { socialAccounts: { edges: [] } };
    });

    const result = await handler();

    expect(result.targetsCreated).toBe(0);

    const update = mutationMock.mock.calls.find((call) => 'updateSocialPost' in call[0]);

    expect(update?.[0].updateSocialPost.__args.data.status).toBe('FAILED');
  });

  it('should do nothing when no post is due', async () => {
    queryMock.mockImplementation(async (request: Record<string, unknown>) => {
      if ('socialPosts' in request) {
        return { socialPosts: { edges: [] } };
      }

      return { socialAccounts: accounts };
    });

    const result = await handler();

    expect(result).toEqual({ postsStarted: 0, targetsCreated: 0 });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../publish-due-posts.logic-function`.

- [ ] **Step 3: Write the scheduler**

```ts
// src/logic-functions/publish-due-posts.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { enqueueJob } from 'twenty-sdk/logic-function';

import { SOCIAL_IDS } from '../constants/universal-identifiers';
import { buildTargetsForPost, type FanOutAccount } from '../lib/fan-out/build-targets-for-post';

const EVERY_FIVE_MINUTES = '*/5 * * * *';

const MAX_POSTS_PER_TICK = 25;

const handler = async () => {
  const client = new CoreApiClient();
  const now = new Date().toISOString();

  const duePosts = (await client.query({
    socialPosts: {
      __args: {
        filter: { status: { eq: 'SCHEDULED' }, scheduledAt: { lte: now } },
        first: MAX_POSTS_PER_TICK,
      },
      edges: { node: { id: true, body: true, mediaUrls: true, scheduledAt: true } },
    },
  })) as { socialPosts?: { edges?: { node: { id: string } }[] } };

  const posts = duePosts.socialPosts?.edges ?? [];

  if (posts.length === 0) {
    return { postsStarted: 0, targetsCreated: 0 };
  }

  const accountResult = (await client.query({
    socialAccounts: {
      __args: { filter: { isActive: { eq: true } }, first: 200 },
      edges: { node: { id: true, platform: true, isActive: true } },
    },
  })) as { socialAccounts?: { edges?: { node: FanOutAccount }[] } };

  const accounts = (accountResult.socialAccounts?.edges ?? []).map((edge) => edge.node);

  let targetsCreated = 0;

  for (const edge of posts) {
    const plans = buildTargetsForPost({ postId: edge.node.id, accounts });

    if (plans.length === 0) {
      await client.mutation({
        updateSocialPost: {
          __args: { id: edge.node.id, data: { status: 'FAILED' } },
          id: true,
        },
      });

      continue;
    }

    await client.mutation({
      updateSocialPost: {
        __args: { id: edge.node.id, data: { status: 'PUBLISHING' } },
        id: true,
      },
    });

    for (const plan of plans) {
      const created = (await client.mutation({
        createSocialPostTarget: { __args: { data: plan }, id: true },
      })) as { createSocialPostTarget: { id: string } };

      await enqueueJob({
        logicFunctionUniversalIdentifier: SOCIAL_IDS.logicFunctions.publishTarget,
        payload: { socialPostTargetId: created.createSocialPostTarget.id },
      });

      targetsCreated += 1;
    }
  }

  return { postsStarted: posts.length, targetsCreated };
};

export default defineLogicFunction({
  universalIdentifier: SOCIAL_IDS.logicFunctions.publishDuePosts,
  name: 'publish-due-posts',
  description: 'Every five minutes, fans due scheduled posts out into targets and enqueues them.',
  timeoutSeconds: 120,
  handler,
  cronTriggerSettings: { pattern: EVERY_FIVE_MINUTES },
});
```

The post is moved to `PUBLISHING` before any target is enqueued, so the next tick's `status: SCHEDULED` filter cannot pick it up twice. Rolling `PUBLISHING` up to `PUBLISHED` or `PARTIALLY_FAILED` once every target settles is deliberately left out: it needs a database event trigger on `socialPostTarget.updated`, which is its own task once real adapters exist.

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test:unit
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add publish-due-posts scheduler"
```

---

### Task 8: Views, navigation, and the end-to-end dry run

**Files:**
- Create: `src/views/social-posts.view.ts`
- Create: `src/navigation-menu-items/social-posts.navigation-menu-item.ts`

- [ ] **Step 1: Write the view**

```ts
// src/views/social-posts.view.ts
import { defineView, ViewKey, ViewType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineView({
  universalIdentifier: SOCIAL_IDS.views.socialPosts,
  objectUniversalIdentifier: SOCIAL_IDS.socialPostObject,
  name: 'All Posts',
  icon: 'IconSpeakerphone',
  type: ViewType.TABLE,
  key: ViewKey.INDEX,
});
```

- [ ] **Step 2: Write the navigation item**

```ts
// src/navigation-menu-items/social-posts.navigation-menu-item.ts
import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import { SOCIAL_IDS } from '../constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: SOCIAL_IDS.navigationMenuItems.socialPosts,
  label: 'Social Posts',
  icon: 'IconSpeakerphone',
  type: NavigationMenuItemType.OBJECT,
  objectUniversalIdentifier: SOCIAL_IDS.socialPostObject,
  position: 0,
});
```

- [ ] **Step 3: Sync**

```bash
yarn twenty apply
```

- [ ] **Step 4: Run the end-to-end dry run**

In the UI:

1. Create a **Social Account**: platform `DRY_RUN`, externalId `test-account`, handle `test`, Active on.
2. Seed its token, since no `onConnect` hook exists for `DRY_RUN`:

```bash
yarn twenty dev:function:exec -n publish-target -p '{"socialPostTargetId":"seed"}'
```

That call fails with `Social post target seed not found`, which is expected and only confirms the function is reachable. Seed the token instead with a one-off Node evaluation in a scratch logic function, or set it manually by temporarily adding this line to `publish-target`'s handler, running it once, then removing it:

```ts
await setAccountToken(SocialPlatform.DRY_RUN, 'test-account', 'not-a-real-token');
```

3. Create a **Social Post**: body `Hello from Twenty`, status `SCHEDULED`, scheduledAt in the past.
4. Wait up to five minutes for the cron, or force it:

```bash
yarn twenty dev:function:exec -n publish-due-posts -p '{}'
yarn twenty dev:function:logs
```

Expected: one Social Post Target appears with status `PUBLISHED`, an `externalPostId` starting `dry-run-`, `attemptCount` 1, and a `publishedAt` timestamp. The parent post sits at `PUBLISHING`.

- [ ] **Step 5: Run the full check and commit**

```bash
yarn lint && yarn typecheck && yarn test:unit
git add -A && git commit -m "feat: add social posts view and navigation"
```

---

## Definition of done

- `yarn lint`, `yarn typecheck`, `yarn test:unit` all pass. 33 unit tests.
- `yarn twenty apply` exits 0.
- The end-to-end dry run in Task 8 produces a `PUBLISHED` target with no network call to any platform.
- `getPublisher(SocialPlatform.FACEBOOK)` throws a clear "No publisher registered" error, proving the seam is empty and ready.

## What each platform plan adds

Every platform plan touches exactly these, and nothing else in this app:

1. A `defineConnectionProvider` file and its `serverVariables` entries in `application-config.ts`.
2. An `onConnect` logic function that discovers accounts, creates `SocialAccount` records, and calls `setAccountToken`.
3. One file under `src/lib/publish/` implementing `SocialPublisher`.
4. One import and one `registerPublisher(...)` line at the bottom of `publisher-registry.ts`.

If a platform plan needs to change `publish-target.logic-function.ts` or the object model, stop and reconsider: the contract is wrong, and fixing it here is cheaper than working around it four times.

## Follow-up, once two or more real adapters exist

- **Post status rollup** — a `socialPostTarget.updated` database event trigger that sets the parent to `PUBLISHED`, `PARTIALLY_FAILED`, or `FAILED` once every target settles.
- **Async status polling** — a cron for targets stuck in `AWAITING_PLATFORM`, needed by Instagram containers and TikTok publish ids.
- **Retry with backoff** — bounded re-enqueue of `FAILED` targets, keyed on `attemptCount`.
- **Composer front component** — per-platform previews and character counts, reading `maxBodyLength` from the registry.
