# TikTok Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** `2026-08-07-social-core.md` must be complete. This plan is independent of the other three platform plans.

**Goal:** Publish videos to TikTok through the Content Posting API, respecting each creator's own privacy settings.

**Architecture:** A TikTok OAuth connection provider; an `onConnect` hook that records the creator; and a `SocialPublisher` that queries creator info, initialises a `PULL_FROM_URL` direct post, and returns `AWAITING_PLATFORM` with the `publish_id`. TikTok posting is inherently asynchronous, so a finisher cron settles targets the same way the Instagram plan does.

**Tech Stack:** TikTok Content Posting API v2, `twenty-sdk`, Vitest 4.

## Global Constraints

- **TikTok's OAuth parameter is `client_key`, not `client_id`.** Task 1 verifies whether Twenty's generic OAuth provider can express that, and branches if it cannot. Do not skip it.
- `privacy_level` must be one of the values the creator info query returns for that specific creator. Sending an unsupported value is rejected, so always query first.
- Rate limit is **6 requests per minute per user access token**. Creator info plus init is two of them per post.
- Title limit is 2200 UTF-16 code units.
- Video URLs must be publicly reachable https. TikTok pulls them server-side.
- **An unaudited client can only post to private accounts.** Everything published before the audit is visible to the creator alone.

## Platform prerequisites

| Requirement | Note |
|---|---|
| TikTok for Developers app | Register at developers.tiktok.com |
| `video.publish` and `user.info.basic` scopes | Requested at app configuration |
| Content Posting API audit | Required to lift the private-only restriction. 4-8 weeks |
| Verified domain for `PULL_FROM_URL` | TikTok requires the media host to be a domain you have verified with them |

That last row catches people out. `PULL_FROM_URL` will not fetch from an arbitrary CDN; the host must be verified in your TikTok developer settings first.

---

## The publish flow

```
POST /v2/post/publish/creator_info/query/   -> privacy options, per-creator limits
        │
        ▼
POST /v2/post/publish/video/init/           -> { data: { publish_id } }
        post_info { title, privacy_level, ... }
        source_info { source: PULL_FROM_URL, video_url }
        │
        ▼  TikTok downloads and processes, taking seconds to minutes
POST /v2/post/publish/status/fetch/         -> PROCESSING_UPLOAD | PUBLISH_COMPLETE | FAILED
        { publish_id }
```

The adapter stops after init and returns `AWAITING_PLATFORM`. Unlike Instagram there is no point polling inline: TikTok processing regularly outlasts a logic function timeout, and the rate limit punishes tight polling.

---

### Task 1: Verify the OAuth parameter name, then build the provider

**Files:**
- Create: `src/lib/publish/tiktok/tiktok-endpoints.ts`
- Create: `src/connection-providers/tiktok.connection-provider.ts`
- Modify: `src/application-config.ts`
- Modify: `src/constants/universal-identifiers.ts`

**Interfaces:**
- Produces: `TIKTOK_API_BASE`, endpoint constants, and `TIKTOK_IDS`.

- [ ] **Step 1: Spike the parameter name**

Twenty's `defineConnectionProvider` sends the client id under the standard OAuth `client_id` parameter. TikTok expects `client_key`. Check whether the provider can override it:

```bash
grep -rn "client_id\|clientIdVariable\|authorizationParams" \
  ../twenty/packages/twenty-server/src/engine/core-modules/application/ \
  --include="*.ts" | grep -iv spec | head -30
```

Adjust the path to your Twenty checkout. Read whichever service builds the authorization URL and the token request.

**Decide now, and record the decision in this file before continuing:**

- **If `authorizationParams` is merged into the authorize URL and the token request accepts an override**, add `authorizationParams: { client_key: '...' }` and continue with Step 2 as written.
- **If the parameter name is hardcoded**, TikTok cannot use the generic provider. Fall back to a hand-rolled flow: two `httpRouteTriggerSettings` logic functions, one that redirects to TikTok's authorize URL and one that receives the callback and exchanges the code, storing the token with `setAccountToken`. That is roughly 120 extra lines and replaces Tasks 1 and 2 here. Everything from Task 3 onward is unaffected.

This spike exists because getting it wrong costs a day of confusing 400s from TikTok.

- [ ] **Step 2: Generate UUIDs and extend the constants**

```bash
for i in $(seq 1 5); do uuidgen | tr '[:upper:]' '[:lower:]'; done
```

```ts
// append to src/constants/universal-identifiers.ts
export const TIKTOK_IDS = {
  connectionProvider: 'REPLACE-T1',
  onConnect: 'REPLACE-T2',
  onDisconnect: 'REPLACE-T3',
  finishPublishes: 'REPLACE-T4',
} as const;
```

- [ ] **Step 3: Write the endpoint constants**

```ts
// src/lib/publish/tiktok/tiktok-endpoints.ts

export const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

export const TIKTOK_CREATOR_INFO_URL = `${TIKTOK_API_BASE}/post/publish/creator_info/query/`;
export const TIKTOK_VIDEO_INIT_URL = `${TIKTOK_API_BASE}/post/publish/video/init/`;
export const TIKTOK_STATUS_URL = `${TIKTOK_API_BASE}/post/publish/status/fetch/`;
export const TIKTOK_USER_INFO_URL = `${TIKTOK_API_BASE}/user/info/`;

export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = `${TIKTOK_API_BASE}/oauth/token/`;
```

- [ ] **Step 4: Write the connection provider**

```ts
// src/connection-providers/tiktok.connection-provider.ts
import { defineConnectionProvider } from 'twenty-sdk/define';

import { TIKTOK_IDS } from '../constants/universal-identifiers';
import { TIKTOK_AUTHORIZE_URL, TIKTOK_TOKEN_URL } from '../lib/publish/tiktok/tiktok-endpoints';

export default defineConnectionProvider({
  universalIdentifier: TIKTOK_IDS.connectionProvider,
  name: 'tiktok',
  displayName: 'TikTok',
  type: 'oauth',
  oauthConfig: {
    authorizationEndpoint: TIKTOK_AUTHORIZE_URL,
    tokenEndpoint: TIKTOK_TOKEN_URL,
    scopes: ['user.info.basic', 'video.publish'],
    clientIdVariable: 'TIKTOK_CLIENT_KEY',
    clientSecretVariable: 'TIKTOK_CLIENT_SECRET',
    tokenRequestContentType: 'form',
    usePkce: true,
  },
  onConnectLogicFunction: { universalIdentifier: TIKTOK_IDS.onConnect },
  onDisconnectLogicFunction: { universalIdentifier: TIKTOK_IDS.onDisconnect },
});
```

If the Step 1 spike found the parameter name is overridable, add it here. If not, delete this file and use the hand-rolled flow instead.

- [ ] **Step 5: Add the server variables**

```ts
// in src/application-config.ts, inside serverVariables
    TIKTOK_CLIENT_KEY: {
      description: 'TikTok app client key from developers.tiktok.com. Sent as client_key, not client_id.',
      isSecret: false,
      isRequired: false,
    },
    TIKTOK_CLIENT_SECRET: {
      description: 'TikTok app client secret.',
      isSecret: true,
      isRequired: false,
    },
```

- [ ] **Step 6: Sync and commit**

```bash
yarn twenty apply
git add -A && git commit -m "feat: add TikTok OAuth connection provider"
```

---

### Task 2: The onConnect hook

**Files:**
- Create: `src/lib/publish/tiktok/tiktok-user-info.ts`
- Create: `src/logic-functions/tiktok-on-connect.logic-function.ts`
- Create: `src/logic-functions/tiktok-on-disconnect.logic-function.ts`
- Test: `src/lib/publish/tiktok/__tests__/tiktok-user-info.test.ts`

**Interfaces:**
- Produces: `fetchTikTokUser(accessToken)` returning `{ openId, displayName }`, and a `SocialAccount` per connected creator.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/tiktok/__tests__/tiktok-user-info.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchTikTokUser } from '../tiktok-user-info';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchTikTokUser', () => {
  it('should return the open id and display name', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { user: { open_id: 'open-1', display_name: 'Praxis Meier' } },
        error: { code: 'ok' },
      }),
    });

    expect(await fetchTikTokUser('tok')).toEqual({
      openId: 'open-1',
      displayName: 'Praxis Meier',
    });
  });

  it('should request the open_id and display_name fields with a bearer token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { user: { open_id: 'open-1' } }, error: { code: 'ok' } }),
    });

    await fetchTikTokUser('tok');

    const [url, init] = fetchMock.mock.calls[0];

    expect(String(url)).toContain('fields=open_id%2Cdisplay_name');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('should fall back to the open id when display name is absent', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { user: { open_id: 'open-1' } }, error: { code: 'ok' } }),
    });

    expect((await fetchTikTokUser('tok')).displayName).toBe('open-1');
  });

  // TikTok returns HTTP 200 with an error object, so ok is not enough.
  it('should throw when the payload carries an error code', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 'access_token_invalid', message: 'Invalid token' } }),
    });

    await expect(fetchTikTokUser('tok')).rejects.toThrow(
      'TikTok user info failed: access_token_invalid Invalid token',
    );
  });

  it('should throw on a transport failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

    await expect(fetchTikTokUser('tok')).rejects.toThrow(
      'TikTok user info failed with 500: boom',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the module**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../tiktok-user-info`.

```ts
// src/lib/publish/tiktok/tiktok-user-info.ts
import { TIKTOK_USER_INFO_URL } from './tiktok-endpoints';

export type TikTokUser = {
  openId: string;
  displayName: string;
};

// TikTok answers 200 with an error object for application-level failures,
// so both layers have to be checked.
export const assertNoTikTokError = (payload: {
  error?: { code?: string; message?: string };
}): void => {
  const code = payload.error?.code;

  if (code !== undefined && code !== 'ok') {
    throw new Error(`TikTok user info failed: ${code} ${payload.error?.message ?? ''}`.trim());
  }
};

export const fetchTikTokUser = async (accessToken: string): Promise<TikTokUser> => {
  const url = new URL(TIKTOK_USER_INFO_URL);

  url.searchParams.set('fields', 'open_id,display_name');

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`TikTok user info failed with ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    data?: { user?: { open_id: string; display_name?: string } };
    error?: { code?: string; message?: string };
  };

  assertNoTikTokError(payload);

  const user = payload.data?.user;

  if (!user) {
    throw new Error('TikTok user info returned no user');
  }

  return { openId: user.open_id, displayName: user.display_name ?? user.open_id };
};
```

- [ ] **Step 3: Write the hooks**

```ts
// src/logic-functions/tiktok-on-connect.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { getConnection } from 'twenty-sdk/logic-function';

import { TIKTOK_IDS } from '../constants/universal-identifiers';
import { setAccountToken } from '../lib/accounts/account-token-store';
import { SocialPlatform } from '../lib/publish/social-platform';
import { fetchTikTokUser } from '../lib/publish/tiktok/tiktok-user-info';

// TikTok access tokens are short-lived; the refresh token lasts a year.
// Recording the access token deadline surfaces reconnect needs.
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const handler = async (payload: { connectionId: string }) => {
  const connection = await getConnection(payload.connectionId);

  if (!connection) {
    throw new Error(`Connection ${payload.connectionId} not found`);
  }

  const user = await fetchTikTokUser(connection.accessToken);

  await setAccountToken(SocialPlatform.TIKTOK, user.openId, connection.accessToken);

  const client = new CoreApiClient();

  const existing = (await client.query({
    socialAccounts: {
      __args: {
        filter: { platform: { eq: 'TIKTOK' }, externalId: { eq: user.openId } },
        first: 1,
      },
      edges: { node: { id: true } },
    },
  })) as { socialAccounts?: { edges?: { node: { id: string } }[] } };

  const data = {
    name: user.displayName,
    platform: 'TIKTOK',
    externalId: user.openId,
    handle: user.displayName,
    isActive: true,
    connectedAt: new Date().toISOString(),
    tokenExpiresAt: new Date(Date.now() + TWENTY_FOUR_HOURS_MS).toISOString(),
  };

  const existingId = existing.socialAccounts?.edges?.[0]?.node.id;

  if (existingId) {
    await client.mutation({
      updateSocialAccount: { __args: { id: existingId, data }, id: true },
    });
  } else {
    await client.mutation({ createSocialAccount: { __args: { data }, id: true } });
  }

  return { accountsLinked: 1 };
};

export default defineLogicFunction({
  universalIdentifier: TIKTOK_IDS.onConnect,
  name: 'tiktok-on-connect',
  description: 'Links the connected TikTok creator as a SocialAccount.',
  timeoutSeconds: 60,
  handler,
});
```

```ts
// src/logic-functions/tiktok-on-disconnect.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { TIKTOK_IDS } from '../constants/universal-identifiers';

const handler = async () => {
  const client = new CoreApiClient();

  const accounts = (await client.query({
    socialAccounts: {
      __args: { filter: { platform: { eq: 'TIKTOK' } }, first: 200 },
      edges: { node: { id: true } },
    },
  })) as { socialAccounts?: { edges?: { node: { id: string } }[] } };

  for (const edge of accounts.socialAccounts?.edges ?? []) {
    await client.mutation({
      updateSocialAccount: { __args: { id: edge.node.id, data: { isActive: false } }, id: true },
    });
  }

  return { deactivated: accounts.socialAccounts?.edges?.length ?? 0 };
};

export default defineLogicFunction({
  universalIdentifier: TIKTOK_IDS.onDisconnect,
  name: 'tiktok-on-disconnect',
  description: 'Deactivates TikTok SocialAccounts when the connection is removed.',
  timeoutSeconds: 60,
  handler,
});
```

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add TikTok connect and disconnect hooks"
```

Expected: PASS, 5 tests.

---

### Task 3: The posting client

**Files:**
- Create: `src/lib/publish/tiktok/tiktok-api.ts`
- Test: `src/lib/publish/tiktok/__tests__/tiktok-api.test.ts`

**Interfaces:**
- Produces: `queryCreatorInfo(accessToken)`, `initDirectPost({...})`, `fetchPublishStatus(publishId, accessToken)`. Tasks 4 and 5 call them.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/tiktok/__tests__/tiktok-api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchPublishStatus, initDirectPost, queryCreatorInfo } from '../tiktok-api';

const fetchMock = vi.fn();

const ok = (data: unknown) => ({
  ok: true,
  json: async () => ({ data, error: { code: 'ok' } }),
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('queryCreatorInfo', () => {
  it('should return the privacy options and nickname', async () => {
    fetchMock.mockResolvedValue(
      ok({
        creator_nickname: 'Praxis Meier',
        privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
        max_video_post_duration_sec: 600,
      }),
    );

    expect(await queryCreatorInfo('tok')).toEqual({
      nickname: 'Praxis Meier',
      privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
      maxVideoDurationSec: 600,
    });
  });

  it('should POST with a bearer token', async () => {
    fetchMock.mockResolvedValue(ok({ privacy_level_options: [] }));

    await queryCreatorInfo('tok');

    const [url, init] = fetchMock.mock.calls[0];

    expect(String(url)).toContain('/post/publish/creator_info/query/');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('should throw on an application-level error', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 'spam_risk_too_many_posts', message: 'Slow down' } }),
    });

    await expect(queryCreatorInfo('tok')).rejects.toThrow(
      'TikTok creator info failed: spam_risk_too_many_posts Slow down',
    );
  });
});

describe('initDirectPost', () => {
  it('should send post_info and PULL_FROM_URL source_info', async () => {
    fetchMock.mockResolvedValue(ok({ publish_id: 'pub-1' }));

    const publishId = await initDirectPost({
      accessToken: 'tok',
      title: 'Hello',
      videoUrl: 'https://cdn.example.com/a.mp4',
      privacyLevel: 'PUBLIC_TO_EVERYONE',
    });

    expect(publishId).toBe('pub-1');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    expect(body).toEqual({
      post_info: {
        title: 'Hello',
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: false,
        disable_stitch: false,
        disable_comment: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: 'https://cdn.example.com/a.mp4',
      },
    });
  });

  it('should throw when the response carries an error code', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 'url_ownership_unverified', message: 'Verify domain' } }),
    });

    await expect(
      initDirectPost({
        accessToken: 'tok',
        title: 'Hello',
        videoUrl: 'https://cdn.example.com/a.mp4',
        privacyLevel: 'PUBLIC_TO_EVERYONE',
      }),
    ).rejects.toThrow('TikTok post init failed: url_ownership_unverified Verify domain');
  });
});

describe('fetchPublishStatus', () => {
  it('should return the status string', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'PUBLISH_COMPLETE' }));

    expect(await fetchPublishStatus('pub-1', 'tok')).toEqual({
      status: 'PUBLISH_COMPLETE',
      failReason: undefined,
    });
  });

  it('should surface the fail reason', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'FAILED', fail_reason: 'video_format_check_failed' }));

    expect(await fetchPublishStatus('pub-1', 'tok')).toEqual({
      status: 'FAILED',
      failReason: 'video_format_check_failed',
    });
  });

  it('should send the publish_id', async () => {
    fetchMock.mockResolvedValue(ok({ status: 'PROCESSING_UPLOAD' }));

    await fetchPublishStatus('pub-1', 'tok');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ publish_id: 'pub-1' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the client**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../tiktok-api`.

```ts
// src/lib/publish/tiktok/tiktok-api.ts
import {
  TIKTOK_CREATOR_INFO_URL,
  TIKTOK_STATUS_URL,
  TIKTOK_VIDEO_INIT_URL,
} from './tiktok-endpoints';

export type CreatorInfo = {
  nickname: string;
  privacyLevelOptions: string[];
  maxVideoDurationSec: number;
};

export type PublishStatus = {
  status: string;
  failReason?: string;
};

type TikTokEnvelope<T> = {
  data?: T;
  error?: { code?: string; message?: string };
};

const postJson = async <T>(
  url: string,
  accessToken: string,
  body: unknown,
  label: string,
): Promise<T> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as TikTokEnvelope<T>;
  const code = payload.error?.code;

  // TikTok answers 200 with an error object for application failures.
  if (code !== undefined && code !== 'ok') {
    throw new Error(`${label} failed: ${code} ${payload.error?.message ?? ''}`.trim());
  }

  return (payload.data ?? {}) as T;
};

export const queryCreatorInfo = async (accessToken: string): Promise<CreatorInfo> => {
  const data = await postJson<{
    creator_nickname?: string;
    privacy_level_options?: string[];
    max_video_post_duration_sec?: number;
  }>(TIKTOK_CREATOR_INFO_URL, accessToken, {}, 'TikTok creator info');

  return {
    nickname: data.creator_nickname ?? '',
    privacyLevelOptions: data.privacy_level_options ?? [],
    maxVideoDurationSec: data.max_video_post_duration_sec ?? 0,
  };
};

export const initDirectPost = async ({
  accessToken,
  title,
  videoUrl,
  privacyLevel,
}: {
  accessToken: string;
  title: string;
  videoUrl: string;
  privacyLevel: string;
}): Promise<string> => {
  const data = await postJson<{ publish_id?: string }>(
    TIKTOK_VIDEO_INIT_URL,
    accessToken,
    {
      post_info: {
        title,
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_stitch: false,
        disable_comment: false,
      },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    },
    'TikTok post init',
  );

  if (!data.publish_id) {
    throw new Error('TikTok post init returned no publish_id');
  }

  return data.publish_id;
};

export const fetchPublishStatus = async (
  publishId: string,
  accessToken: string,
): Promise<PublishStatus> => {
  const data = await postJson<{ status?: string; fail_reason?: string }>(
    TIKTOK_STATUS_URL,
    accessToken,
    { publish_id: publishId },
    'TikTok status fetch',
  );

  return { status: data.status ?? 'UNKNOWN', failReason: data.fail_reason };
};
```

- [ ] **Step 3: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add TikTok content posting client"
```

Expected: PASS, 8 tests.

---

### Task 4: The TikTok publisher

**Files:**
- Create: `src/lib/publish/tiktok/tiktok-publisher.ts`
- Modify: `src/lib/publish/publisher-registry.ts`
- Test: `src/lib/publish/tiktok/__tests__/tiktok-publisher.test.ts`

**Interfaces:**
- Consumes: Task 3's client, `SocialPublisher` (core Task 4).
- Produces: `tiktokPublisher`, registered for `SocialPlatform.TIKTOK`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/tiktok/__tests__/tiktok-publisher.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { creatorInfoMock, initMock } = vi.hoisted(() => ({
  creatorInfoMock: vi.fn(),
  initMock: vi.fn(),
}));

vi.mock('../tiktok-api', () => ({
  queryCreatorInfo: creatorInfoMock,
  initDirectPost: initMock,
  fetchPublishStatus: vi.fn(),
}));

import { tiktokPublisher } from '../tiktok-publisher';

const input = {
  body: 'Hello from Twenty',
  mediaUrls: ['https://cdn.example.com/a.mp4'],
  accountExternalId: 'open-1',
  accessToken: 'tok',
};

beforeEach(() => {
  vi.clearAllMocks();
  creatorInfoMock.mockResolvedValue({
    nickname: 'Praxis Meier',
    privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
    maxVideoDurationSec: 600,
  });
  initMock.mockResolvedValue('pub-1');
});

describe('tiktokPublisher', () => {
  it('should declare the TIKTOK platform and require media', () => {
    expect(tiktokPublisher.platform).toBe('TIKTOK');
    expect(tiktokPublisher.requiresMedia).toBe(true);
    expect(tiktokPublisher.maxBodyLength).toBe(2200);
  });

  it('should query creator info before initialising the post', async () => {
    await tiktokPublisher.publish(input);

    expect(creatorInfoMock).toHaveBeenCalledWith('tok');
    expect(creatorInfoMock.mock.invocationCallOrder[0]).toBeLessThan(
      initMock.mock.invocationCallOrder[0],
    );
  });

  it('should return AWAITING_PLATFORM with the publish id', async () => {
    expect(await tiktokPublisher.publish(input)).toEqual({
      status: 'AWAITING_PLATFORM',
      externalPostId: 'pub-1',
    });
  });

  it('should pick the most public privacy level the creator allows', async () => {
    await tiktokPublisher.publish(input);

    expect(initMock.mock.calls[0][0].privacyLevel).toBe('PUBLIC_TO_EVERYONE');
  });

  it('should fall back to a more restrictive level when public is unavailable', async () => {
    creatorInfoMock.mockResolvedValue({
      nickname: 'x',
      privacyLevelOptions: ['SELF_ONLY'],
      maxVideoDurationSec: 60,
    });

    await tiktokPublisher.publish(input);

    expect(initMock.mock.calls[0][0].privacyLevel).toBe('SELF_ONLY');
  });

  it('should fail when the creator offers no privacy option', async () => {
    creatorInfoMock.mockResolvedValue({
      nickname: 'x',
      privacyLevelOptions: [],
      maxVideoDurationSec: 60,
    });

    expect(await tiktokPublisher.publish(input)).toEqual({
      status: 'FAILED',
      error: 'TikTok returned no available privacy level for this creator',
    });
    expect(initMock).not.toHaveBeenCalled();
  });

  it('should fail when no media url is given', async () => {
    expect(await tiktokPublisher.publish({ ...input, mediaUrls: [] })).toEqual({
      status: 'FAILED',
      error: 'TikTok requires a video URL',
    });
    expect(creatorInfoMock).not.toHaveBeenCalled();
  });

  it('should return FAILED rather than throw when the API errors', async () => {
    initMock.mockRejectedValue(new Error('url_ownership_unverified Verify domain'));

    expect(await tiktokPublisher.publish(input)).toEqual({
      status: 'FAILED',
      error: 'url_ownership_unverified Verify domain',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the adapter**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../tiktok-publisher`.

```ts
// src/lib/publish/tiktok/tiktok-publisher.ts
import { type PublishInput, type PublishResult, type SocialPublisher } from '../publisher.type';
import { SocialPlatform } from '../social-platform';
import { initDirectPost, queryCreatorInfo } from './tiktok-api';

const MAX_TITLE_LENGTH = 2200;

// Most public first. TikTok rejects a privacy_level the creator has not
// enabled, so always choose from what creator_info actually returned.
const PRIVACY_PREFERENCE = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
];

const pickPrivacyLevel = (available: string[]): string | null =>
  PRIVACY_PREFERENCE.find((level) => available.includes(level)) ?? available[0] ?? null;

const publish = async (input: PublishInput): Promise<PublishResult> => {
  const videoUrl = input.mediaUrls[0];

  if (videoUrl === undefined) {
    return { status: 'FAILED', error: 'TikTok requires a video URL' };
  }

  try {
    const creatorInfo = await queryCreatorInfo(input.accessToken);
    const privacyLevel = pickPrivacyLevel(creatorInfo.privacyLevelOptions);

    if (privacyLevel === null) {
      return {
        status: 'FAILED',
        error: 'TikTok returned no available privacy level for this creator',
      };
    }

    const publishId = await initDirectPost({
      accessToken: input.accessToken,
      title: input.body,
      videoUrl,
      privacyLevel,
    });

    // TikTok downloads and transcodes asynchronously, regularly for
    // longer than a logic function may run. The finisher cron settles it.
    return { status: 'AWAITING_PLATFORM', externalPostId: publishId };
  } catch (error) {
    return {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'TikTok publish failed',
    };
  }
};

export const tiktokPublisher: SocialPublisher = {
  platform: SocialPlatform.TIKTOK,
  maxBodyLength: MAX_TITLE_LENGTH,
  requiresMedia: true,
  publish,
};
```

- [ ] **Step 3: Register it**

```ts
// in src/lib/publish/publisher-registry.ts
import { tiktokPublisher } from './tiktok/tiktok-publisher';

registerPublisher(tiktokPublisher);
```

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && yarn lint && git add -A && git commit -m "feat: add TikTok direct post publisher"
```

Expected: PASS, 8 new tests.

---

### Task 5: The publish finisher

**Files:**
- Create: `src/logic-functions/tiktok-finish-publishes.logic-function.ts`
- Test: `src/logic-functions/__tests__/tiktok-finish-publishes.test.ts`

**Interfaces:**
- Consumes: `fetchPublishStatus` (Task 3), `getAccountToken` (core Task 6).
- Produces: a cron function settling TikTok targets left in `AWAITING_PLATFORM`.

- [ ] **Step 1: Write the failing test**

```ts
// src/logic-functions/__tests__/tiktok-finish-publishes.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, mutationMock, kvGetMock, statusMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  kvGetMock: vi.fn(),
  statusMock: vi.fn(),
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

vi.mock('../../lib/publish/tiktok/tiktok-api', () => ({
  fetchPublishStatus: statusMock,
  queryCreatorInfo: vi.fn(),
  initDirectPost: vi.fn(),
}));

import tiktokFinishPublishes from '../tiktok-finish-publishes.logic-function';

const handler = tiktokFinishPublishes.config.handler as () => Promise<{ settled: number }>;

const dataOf = () =>
  mutationMock.mock.calls.find((call) => 'updateSocialPostTarget' in call[0])?.[0]
    .updateSocialPostTarget.__args.data;

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({
    socialPostTargets: {
      edges: [
        {
          node: {
            id: 'target-1',
            externalPostId: 'pub-1',
            socialAccount: { externalId: 'open-1' },
          },
        },
      ],
    },
  });
  mutationMock.mockResolvedValue({});
  kvGetMock.mockResolvedValue('tok');
  statusMock.mockResolvedValue({ status: 'PUBLISH_COMPLETE' });
});

describe('tiktok-finish-publishes handler', () => {
  it('should mark a completed publish as PUBLISHED', async () => {
    expect(await handler()).toEqual({ settled: 1 });
    expect(dataOf()).toMatchObject({ status: 'PUBLISHED' });
    expect(dataOf().publishedAt).toEqual(expect.any(String));
  });

  it('should query only AWAITING_PLATFORM TikTok targets', async () => {
    await handler();

    expect(queryMock.mock.calls[0][0].socialPostTargets.__args.filter).toEqual({
      platform: { eq: 'TIKTOK' },
      status: { eq: 'AWAITING_PLATFORM' },
    });
  });

  it('should leave a processing publish alone', async () => {
    statusMock.mockResolvedValue({ status: 'PROCESSING_UPLOAD' });

    expect(await handler()).toEqual({ settled: 0 });
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('should fail the target with the TikTok fail reason', async () => {
    statusMock.mockResolvedValue({ status: 'FAILED', failReason: 'video_format_check_failed' });

    await handler();

    expect(dataOf()).toMatchObject({ status: 'FAILED' });
    expect(dataOf().errorMessage).toContain('video_format_check_failed');
  });

  it('should fail the target when its token is gone', async () => {
    kvGetMock.mockResolvedValue(null);

    await handler();

    expect(dataOf().errorMessage).toContain('No stored token');
  });

  it('should fail the target when the status call throws', async () => {
    statusMock.mockRejectedValue(new Error('access_token_invalid'));

    await handler();

    expect(dataOf()).toMatchObject({ status: 'FAILED' });
    expect(dataOf().errorMessage).toBe('access_token_invalid');
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the function**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../tiktok-finish-publishes.logic-function`.

```ts
// src/logic-functions/tiktok-finish-publishes.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { TIKTOK_IDS } from '../constants/universal-identifiers';
import { getAccountToken } from '../lib/accounts/account-token-store';
import { SocialPlatform } from '../lib/publish/social-platform';
import { fetchPublishStatus } from '../lib/publish/tiktok/tiktok-api';

// TikTok allows 6 requests per minute per token, so keep the tick slow
// and the batch small.
const EVERY_THREE_MINUTES = '*/3 * * * *';
const MAX_TARGETS_PER_TICK = 5;

type AwaitingTarget = {
  id: string;
  externalPostId: string;
  socialAccount: { externalId: string };
};

const handler = async () => {
  const client = new CoreApiClient();

  const found = (await client.query({
    socialPostTargets: {
      __args: {
        filter: { platform: { eq: 'TIKTOK' }, status: { eq: 'AWAITING_PLATFORM' } },
        first: MAX_TARGETS_PER_TICK,
      },
      edges: {
        node: { id: true, externalPostId: true, socialAccount: { externalId: true } },
      },
    },
  })) as { socialPostTargets?: { edges?: { node: AwaitingTarget }[] } };

  let settled = 0;

  const settle = async (targetId: string, data: Record<string, unknown>) => {
    await client.mutation({
      updateSocialPostTarget: { __args: { id: targetId, data }, id: true },
    });
    settled += 1;
  };

  for (const edge of found.socialPostTargets?.edges ?? []) {
    const target = edge.node;
    const token = await getAccountToken(SocialPlatform.TIKTOK, target.socialAccount.externalId);

    if (token === null) {
      await settle(target.id, {
        status: 'FAILED',
        errorMessage: `No stored token for TikTok creator ${target.socialAccount.externalId}`,
      });
      continue;
    }

    try {
      const { status, failReason } = await fetchPublishStatus(target.externalPostId, token);

      if (status === 'PUBLISH_COMPLETE') {
        await settle(target.id, {
          status: 'PUBLISHED',
          publishedAt: new Date().toISOString(),
          errorMessage: null,
        });
        continue;
      }

      if (status === 'FAILED') {
        await settle(target.id, {
          status: 'FAILED',
          errorMessage: `TikTok publish failed: ${failReason ?? 'unknown reason'}`,
        });
      }

      // Anything else is still in flight; leave it for the next tick.
    } catch (error) {
      await settle(target.id, {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'TikTok status check failed',
      });
    }
  }

  return { settled };
};

export default defineLogicFunction({
  universalIdentifier: TIKTOK_IDS.finishPublishes,
  name: 'tiktok-finish-publishes',
  description: 'Settles TikTok targets whose publish was still processing.',
  timeoutSeconds: 120,
  handler,
  cronTriggerSettings: { pattern: EVERY_THREE_MINUTES },
});
```

A target stuck in `AWAITING_PLATFORM` forever is possible if TikTok never reaches a terminal status. Bounding that with an age check is a follow-up.

- [ ] **Step 3: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add TikTok publish finisher cron"
```

Expected: PASS, 6 tests.

---

### Task 6: Verify against a real account

**Files:** none.

- [ ] **Step 1: Configure the TikTok app**

At developers.tiktok.com: create an app, add the **Content Posting API** and **Login Kit** products, request `user.info.basic` and `video.publish`, and add Twenty's redirect URI.

- [ ] **Step 2: Verify the media domain**

In the app's Content Posting API settings, add and verify the domain that will host your video URLs. `PULL_FROM_URL` refuses unverified hosts, and the error (`url_ownership_unverified`) is easy to misread as a bad URL.

- [ ] **Step 3: Connect**

Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` at **Settings → Admin Panel → Apps → Social**, then connect.

Expected: a Social Account with `platform: TIKTOK` and the creator's display name.

- [ ] **Step 4: Publish a video**

Create a Social Post with a title under 2200 characters and one https `.mp4` URL on the verified domain, `SCHEDULED`, `scheduledAt` in the past.

```bash
yarn twenty dev:function:exec -n publish-due-posts -p '{}'
yarn twenty dev:function:logs
```

Expected: the target reaches `AWAITING_PLATFORM` with a `publish_id`, then `PUBLISHED` within a few minutes once the finisher cron runs.

**The video will be private until your app passes the Content Posting API audit.** That is the documented behaviour for unaudited clients, not a bug in this code. Check the creator's profile while logged in as that creator to confirm it posted.

- [ ] **Step 5: Full check and commit**

```bash
yarn lint && yarn typecheck && yarn test:unit
git add -A && git commit -m "docs: record TikTok verification steps"
```

---

## Definition of done

- All unit tests pass. 27 new tests across Tasks 2 to 5.
- Connecting TikTok creates a Social Account with the creator's open id.
- A scheduled video post reaches `AWAITING_PLATFORM` and is settled to `PUBLISHED` by the finisher cron.
- The privacy level sent is always one the creator info query returned.
- A post with no media is rejected by the core validator before any API call.
- The Task 1 spike decision is written down in this file.

## Known limitations, each a follow-up

- **`PULL_FROM_URL` only.** `FILE_UPLOAD` with chunked PUT is not implemented, so media must be hosted on a TikTok-verified domain.
- **Video only.** TikTok photo posts use a different init endpoint.
- **No duet, stitch, or comment controls.** All three are hardcoded to enabled.
- **No stuck-target timeout.** A target that never reaches a terminal TikTok status stays `AWAITING_PLATFORM` indefinitely.
- **No rate-limit backoff.** The 6-per-minute limit is respected by cron pacing and batch size, not by measurement.
