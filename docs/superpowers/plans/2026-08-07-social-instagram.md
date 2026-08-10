# Instagram Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisites:** `2026-08-07-social-core.md` and `2026-08-07-social-facebook.md` must both be complete. Instagram rides entirely on the Meta connection, so there is no new OAuth flow, no new server variables, and no reconnect.

**Goal:** Publish images and Reels to Instagram Business accounts linked to already-connected Facebook Pages.

**Architecture:** Extend the Meta `onConnect` hook to discover the `instagram_business_account` behind each Page and register it as a second `SocialAccount`. Add one `SocialPublisher` implementing Instagram's two-step container-then-publish flow.

**Tech Stack:** Meta Graph API v25.0, `twenty-sdk`, Vitest 4.

## Global Constraints

- The Meta connection provider already requests `instagram_basic` and `instagram_content_publish`. Do not add a second provider.
- Instagram cannot post text alone. `requiresMedia` is `true`, which the core validator already enforces.
- Media URLs must be publicly reachable over https. Instagram fetches them server-side; a signed or auth-gated URL fails.
- Caption limit is 2200 characters.
- Publishing limit is **100 API-published posts per rolling 24 hours per account**.
- The IG user token is the Page token of the Page it is linked to. Store it under the IG user id so the core's `getAccountToken` finds it.

## Platform prerequisites

| Requirement | Note |
|---|---|
| Instagram Business or Creator account | A personal account cannot be published to via API |
| Linked to a Facebook Page | The link is what makes the account discoverable |
| App Review: `instagram_basic`, `instagram_content_publish` | Development mode covers app admins while you build |

---

## The publish flow

```
POST /{ig-user-id}/media            -> { id: container_id }
      image_url | video_url, caption, media_type
        │
        ▼  images are usually FINISHED immediately; Reels take seconds to minutes
GET /{container_id}?fields=status_code  -> IN_PROGRESS | FINISHED | ERROR | EXPIRED
        │
        ▼  once FINISHED
POST /{ig-user-id}/media_publish    -> { id: media_id }
      creation_id = container_id
```

The adapter polls inline for up to 60 seconds. That covers every image and most Reels. If the container is still `IN_PROGRESS` when the budget runs out, the adapter returns `AWAITING_PLATFORM` with the container id, and the finisher cron in Task 4 completes it.

---

### Task 1: Discover Instagram accounts

**Files:**
- Create: `src/lib/publish/instagram/discover-instagram-accounts.ts`
- Modify: `src/logic-functions/meta-on-connect.logic-function.ts`
- Test: `src/lib/publish/instagram/__tests__/discover-instagram-accounts.test.ts`

**Interfaces:**
- Consumes: `GRAPH_API_BASE` (Facebook plan Task 1).
- Produces: `findInstagramAccountForPage(pageId, pageToken)`, called from the Meta `onConnect` hook.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/instagram/__tests__/discover-instagram-accounts.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findInstagramAccountForPage } from '../discover-instagram-accounts';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('findInstagramAccountForPage', () => {
  it('should return the linked business account id and username', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        instagram_business_account: { id: '178414', username: 'praxis_meier' },
      }),
    });

    expect(await findInstagramAccountForPage('111', 'page-tok')).toEqual({
      id: '178414',
      username: 'praxis_meier',
    });
  });

  it('should request the instagram_business_account field with its subfields', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await findInstagramAccountForPage('111', 'page-tok');

    const url = new URL(fetchMock.mock.calls[0][0]);

    expect(url.pathname).toContain('/111');
    expect(url.searchParams.get('fields')).toBe('instagram_business_account{id,username}');
    expect(url.searchParams.get('access_token')).toBe('page-tok');
  });

  it('should return null when the page has no linked Instagram account', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    expect(await findInstagramAccountForPage('111', 'page-tok')).toBeNull();
  });

  it('should return null rather than throw when Meta rejects the lookup', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'no permission' });

    expect(await findInstagramAccountForPage('111', 'page-tok')).toBeNull();
  });

  it('should fall back to the id when username is absent', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ instagram_business_account: { id: '178414' } }),
    });

    expect(await findInstagramAccountForPage('111', 'page-tok')).toEqual({
      id: '178414',
      username: '178414',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../discover-instagram-accounts`.

- [ ] **Step 3: Write the discovery module**

```ts
// src/lib/publish/instagram/discover-instagram-accounts.ts
import { GRAPH_API_BASE } from '../facebook/graph-api-version';

export type InstagramAccount = {
  id: string;
  username: string;
};

// Returns null rather than throwing: most Pages have no linked Instagram
// account, and a missing link must not abort the whole connect flow.
export const findInstagramAccountForPage = async (
  pageId: string,
  pageToken: string,
): Promise<InstagramAccount | null> => {
  const url = new URL(`${GRAPH_API_BASE}/${pageId}`);

  url.searchParams.set('fields', 'instagram_business_account{id,username}');
  url.searchParams.set('access_token', pageToken);

  const response = await fetch(url.toString());

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    instagram_business_account?: { id: string; username?: string };
  };

  const account = payload.instagram_business_account;

  if (!account) {
    return null;
  }

  return { id: account.id, username: account.username ?? account.id };
};
```

- [ ] **Step 4: Extend the Meta onConnect hook**

Inside the `for (const page of pages)` loop in `src/logic-functions/meta-on-connect.logic-function.ts`, after the Facebook `SocialAccount` upsert, append:

```ts
    // Instagram publishes with the Page token of the Page it is linked
    // to, stored under the IG user id so getAccountToken finds it.
    const instagramAccount = await findInstagramAccountForPage(page.id, page.accessToken);

    if (instagramAccount !== null) {
      await setAccountToken(SocialPlatform.INSTAGRAM, instagramAccount.id, page.accessToken);

      const existingInstagram = (await client.query({
        socialAccounts: {
          __args: {
            filter: { platform: { eq: 'INSTAGRAM' }, externalId: { eq: instagramAccount.id } },
            first: 1,
          },
          edges: { node: { id: true } },
        },
      })) as { socialAccounts?: { edges?: { node: { id: string } }[] } };

      const instagramData = {
        name: `@${instagramAccount.username}`,
        platform: 'INSTAGRAM',
        externalId: instagramAccount.id,
        handle: instagramAccount.username,
        isActive: true,
        connectedAt: new Date().toISOString(),
        tokenExpiresAt: null,
      };

      const existingInstagramId = existingInstagram.socialAccounts?.edges?.[0]?.node.id;

      if (existingInstagramId) {
        await client.mutation({
          updateSocialAccount: { __args: { id: existingInstagramId, data: instagramData }, id: true },
        });
      } else {
        await client.mutation({
          createSocialAccount: { __args: { data: instagramData }, id: true },
        });
      }
    }
```

Add the import at the top:

```ts
import { findInstagramAccountForPage } from '../lib/publish/instagram/discover-instagram-accounts';
```

- [ ] **Step 5: Extend the onConnect test**

Add to `src/logic-functions/__tests__/meta-on-connect.test.ts`. Mock the new module alongside the existing mocks:

```ts
const { findInstagramMock } = vi.hoisted(() => ({ findInstagramMock: vi.fn() }));

vi.mock('../../lib/publish/instagram/discover-instagram-accounts', () => ({
  findInstagramAccountForPage: findInstagramMock,
}));
```

Default it to `null` in `beforeEach` so the existing tests keep their meaning:

```ts
  findInstagramMock.mockResolvedValue(null);
```

Then add two tests:

```ts
  it('should create an Instagram SocialAccount when the page has one linked', async () => {
    findInstagramMock.mockResolvedValue({ id: '178414', username: 'praxis_meier' });

    await handler({ connectionId: 'conn-1', workspaceId: 'ws-1' });

    const instagramCreate = mutationMock.mock.calls
      .filter((call) => 'createSocialAccount' in call[0])
      .map((call) => call[0].createSocialAccount.__args.data)
      .find((data) => data.platform === 'INSTAGRAM');

    expect(instagramCreate).toMatchObject({
      externalId: '178414',
      handle: 'praxis_meier',
      name: '@praxis_meier',
    });
  });

  it('should store the page token under the Instagram user id', async () => {
    findInstagramMock.mockResolvedValue({ id: '178414', username: 'praxis_meier' });

    await handler({ connectionId: 'conn-1', workspaceId: 'ws-1' });

    expect(kvSetMock).toHaveBeenCalledWith('token:INSTAGRAM:178414', 'page-tok-1');
  });
```

- [ ] **Step 6: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: discover Instagram business accounts on Meta connect"
```

Expected: PASS, 7 new tests.

---

### Task 2: The container client

**Files:**
- Create: `src/lib/publish/instagram/instagram-api.ts`
- Test: `src/lib/publish/instagram/__tests__/instagram-api.test.ts`

**Interfaces:**
- Produces: `createMediaContainer(...)`, `getContainerStatus(...)`, `publishContainer(...)`. Tasks 3 and 4 call them.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/instagram/__tests__/instagram-api.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMediaContainer, getContainerStatus, publishContainer } from '../instagram-api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMediaContainer', () => {
  it('should post an image container with caption and media type', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'container-1' }) });

    const id = await createMediaContainer({
      instagramUserId: '178414',
      accessToken: 'tok',
      mediaUrl: 'https://cdn.example.com/a.jpg',
      caption: 'Hello',
      isVideo: false,
    });

    expect(id).toBe('container-1');

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toContain('/178414/media');

    const body = new URLSearchParams(init.body as string);

    expect(body.get('image_url')).toBe('https://cdn.example.com/a.jpg');
    expect(body.get('caption')).toBe('Hello');
    expect(body.get('media_type')).toBe('IMAGE');
    expect(body.get('video_url')).toBeNull();
  });

  it('should post a REELS container for a video', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'container-2' }) });

    await createMediaContainer({
      instagramUserId: '178414',
      accessToken: 'tok',
      mediaUrl: 'https://cdn.example.com/a.mp4',
      caption: 'Hello',
      isVideo: true,
    });

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);

    expect(body.get('video_url')).toBe('https://cdn.example.com/a.mp4');
    expect(body.get('media_type')).toBe('REELS');
    expect(body.get('image_url')).toBeNull();
  });

  it('should throw with the Meta error message on failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Media download failed"}}',
    });

    await expect(
      createMediaContainer({
        instagramUserId: '178414',
        accessToken: 'tok',
        mediaUrl: 'https://cdn.example.com/a.jpg',
        caption: '',
        isVideo: false,
      }),
    ).rejects.toThrow('Instagram container creation failed with 400: Media download failed');
  });
});

describe('getContainerStatus', () => {
  it('should return the status code', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status_code: 'FINISHED' }) });

    expect(await getContainerStatus('container-1', 'tok')).toBe('FINISHED');
  });

  it('should request the status_code field', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status_code: 'IN_PROGRESS' }) });

    await getContainerStatus('container-1', 'tok');

    const url = new URL(fetchMock.mock.calls[0][0]);

    expect(url.searchParams.get('fields')).toBe('status_code');
  });

  it('should report ERROR when the lookup itself fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });

    expect(await getContainerStatus('container-1', 'tok')).toBe('ERROR');
  });
});

describe('publishContainer', () => {
  it('should publish with creation_id and return the media id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'media-9' }) });

    expect(await publishContainer('178414', 'container-1', 'tok')).toBe('media-9');

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toContain('/178414/media_publish');
    expect(new URLSearchParams(init.body as string).get('creation_id')).toBe('container-1');
  });

  it('should throw with the Meta error message on failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"The media is not ready"}}',
    });

    await expect(publishContainer('178414', 'container-1', 'tok')).rejects.toThrow(
      'Instagram publish failed with 400: The media is not ready',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../instagram-api`.

- [ ] **Step 3: Write the client**

```ts
// src/lib/publish/instagram/instagram-api.ts
import { GRAPH_API_BASE } from '../facebook/graph-api-version';

export type ContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

const extractMetaError = (raw: string): string => {
  try {
    return (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw;
  } catch {
    return raw;
  }
};

const postForm = async (url: string, form: URLSearchParams): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

export const createMediaContainer = async ({
  instagramUserId,
  accessToken,
  mediaUrl,
  caption,
  isVideo,
}: {
  instagramUserId: string;
  accessToken: string;
  mediaUrl: string;
  caption: string;
  isVideo: boolean;
}): Promise<string> => {
  const form = new URLSearchParams();

  form.set('access_token', accessToken);
  form.set('caption', caption);

  if (isVideo) {
    form.set('video_url', mediaUrl);
    // Plain VIDEO is deprecated for feed posts; REELS is the current type.
    form.set('media_type', 'REELS');
  } else {
    form.set('image_url', mediaUrl);
    form.set('media_type', 'IMAGE');
  }

  const response = await postForm(`${GRAPH_API_BASE}/${instagramUserId}/media`, form);

  if (!response.ok) {
    throw new Error(
      `Instagram container creation failed with ${response.status}: ${extractMetaError(await response.text())}`,
    );
  }

  return ((await response.json()) as { id: string }).id;
};

export const getContainerStatus = async (
  containerId: string,
  accessToken: string,
): Promise<ContainerStatus> => {
  const url = new URL(`${GRAPH_API_BASE}/${containerId}`);

  url.searchParams.set('fields', 'status_code');
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url.toString());

  // A failed status lookup is indistinguishable from a dead container
  // for our purposes, and treating it as ERROR keeps the caller simple.
  if (!response.ok) {
    return 'ERROR';
  }

  return ((await response.json()) as { status_code: ContainerStatus }).status_code;
};

export const publishContainer = async (
  instagramUserId: string,
  containerId: string,
  accessToken: string,
): Promise<string> => {
  const form = new URLSearchParams();

  form.set('access_token', accessToken);
  form.set('creation_id', containerId);

  const response = await postForm(`${GRAPH_API_BASE}/${instagramUserId}/media_publish`, form);

  if (!response.ok) {
    throw new Error(
      `Instagram publish failed with ${response.status}: ${extractMetaError(await response.text())}`,
    );
  }

  return ((await response.json()) as { id: string }).id;
};
```

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add Instagram container API client"
```

Expected: PASS, 8 tests.

---

### Task 3: The Instagram publisher

**Files:**
- Create: `src/lib/publish/instagram/instagram-publisher.ts`
- Modify: `src/lib/publish/publisher-registry.ts`
- Test: `src/lib/publish/instagram/__tests__/instagram-publisher.test.ts`

**Interfaces:**
- Consumes: Task 2's client, `SocialPublisher` (core Task 4).
- Produces: `instagramPublisher`, registered for `SocialPlatform.INSTAGRAM`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/instagram/__tests__/instagram-publisher.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createContainerMock, getStatusMock, publishMock } = vi.hoisted(() => ({
  createContainerMock: vi.fn(),
  getStatusMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock('../instagram-api', () => ({
  createMediaContainer: createContainerMock,
  getContainerStatus: getStatusMock,
  publishContainer: publishMock,
}));

import { instagramPublisher } from '../instagram-publisher';

const input = {
  body: 'Hello from Twenty',
  mediaUrls: ['https://cdn.example.com/a.jpg'],
  accountExternalId: '178414',
  accessToken: 'tok',
};

beforeEach(() => {
  vi.clearAllMocks();
  createContainerMock.mockResolvedValue('container-1');
  getStatusMock.mockResolvedValue('FINISHED');
  publishMock.mockResolvedValue('media-9');
});

describe('instagramPublisher', () => {
  it('should declare the INSTAGRAM platform and require media', () => {
    expect(instagramPublisher.platform).toBe('INSTAGRAM');
    expect(instagramPublisher.requiresMedia).toBe(true);
    expect(instagramPublisher.maxBodyLength).toBe(2200);
  });

  it('should create a container then publish it', async () => {
    const result = await instagramPublisher.publish(input);

    expect(createContainerMock).toHaveBeenCalledWith({
      instagramUserId: '178414',
      accessToken: 'tok',
      mediaUrl: 'https://cdn.example.com/a.jpg',
      caption: 'Hello from Twenty',
      isVideo: false,
    });
    expect(publishMock).toHaveBeenCalledWith('178414', 'container-1', 'tok');
    expect(result).toEqual({
      status: 'PUBLISHED',
      externalPostId: 'media-9',
      permalink: 'https://www.instagram.com/p/media-9',
    });
  });

  it('should detect a video by extension', async () => {
    await instagramPublisher.publish({
      ...input,
      mediaUrls: ['https://cdn.example.com/clip.MP4?v=2'],
    });

    expect(createContainerMock.mock.calls[0][0].isVideo).toBe(true);
  });

  it('should return AWAITING_PLATFORM when the container is still processing', async () => {
    getStatusMock.mockResolvedValue('IN_PROGRESS');

    const result = await instagramPublisher.publish(input);

    expect(result).toEqual({ status: 'AWAITING_PLATFORM', externalPostId: 'container-1' });
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('should fail when the container reports ERROR', async () => {
    getStatusMock.mockResolvedValue('ERROR');

    const result = await instagramPublisher.publish(input);

    expect(result).toEqual({
      status: 'FAILED',
      error: 'Instagram container container-1 reported ERROR',
    });
  });

  it('should fail when the container has EXPIRED', async () => {
    getStatusMock.mockResolvedValue('EXPIRED');

    const result = await instagramPublisher.publish(input);

    expect(result.status).toBe('FAILED');
  });

  it('should fail when no media url is given', async () => {
    const result = await instagramPublisher.publish({ ...input, mediaUrls: [] });

    expect(result).toEqual({
      status: 'FAILED',
      error: 'Instagram requires a media URL',
    });
    expect(createContainerMock).not.toHaveBeenCalled();
  });

  it('should return FAILED rather than throw when the API errors', async () => {
    createContainerMock.mockRejectedValue(new Error('Media download failed'));

    expect(await instagramPublisher.publish(input)).toEqual({
      status: 'FAILED',
      error: 'Media download failed',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../instagram-publisher`.

- [ ] **Step 3: Write the adapter**

```ts
// src/lib/publish/instagram/instagram-publisher.ts
import { type PublishInput, type PublishResult, type SocialPublisher } from '../publisher.type';
import { SocialPlatform } from '../social-platform';
import { createMediaContainer, getContainerStatus, publishContainer } from './instagram-api';

const MAX_CAPTION_LENGTH = 2200;

// Meta recommends polling once per minute for at most five minutes. A
// logic function cannot sit that long, so poll briefly here and hand
// anything slower to the finisher cron.
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5_000;

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'];

const isVideoUrl = (url: string): boolean => {
  const pathname = url.split('?')[0].toLowerCase();

  return VIDEO_EXTENSIONS.some((extension) => pathname.endsWith(extension));
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const publish = async (input: PublishInput): Promise<PublishResult> => {
  const mediaUrl = input.mediaUrls[0];

  if (mediaUrl === undefined) {
    return { status: 'FAILED', error: 'Instagram requires a media URL' };
  }

  try {
    const containerId = await createMediaContainer({
      instagramUserId: input.accountExternalId,
      accessToken: input.accessToken,
      mediaUrl,
      caption: input.body,
      isVideo: isVideoUrl(mediaUrl),
    });

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const status = await getContainerStatus(containerId, input.accessToken);

      if (status === 'FINISHED') {
        const mediaId = await publishContainer(
          input.accountExternalId,
          containerId,
          input.accessToken,
        );

        return {
          status: 'PUBLISHED',
          externalPostId: mediaId,
          permalink: `https://www.instagram.com/p/${mediaId}`,
        };
      }

      if (status === 'ERROR' || status === 'EXPIRED') {
        return {
          status: 'FAILED',
          error: `Instagram container ${containerId} reported ${status}`,
        };
      }

      if (status === 'PUBLISHED') {
        return { status: 'PUBLISHED', externalPostId: containerId };
      }

      await sleep(POLL_INTERVAL_MS);
    }

    // Still IN_PROGRESS. The finisher cron owns it from here.
    return { status: 'AWAITING_PLATFORM', externalPostId: containerId };
  } catch (error) {
    return {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Instagram publish failed',
    };
  }
};

export const instagramPublisher: SocialPublisher = {
  platform: SocialPlatform.INSTAGRAM,
  maxBodyLength: MAX_CAPTION_LENGTH,
  requiresMedia: true,
  publish,
};
```

The first test's happy path returns on attempt 0 without sleeping, so the suite stays fast. Only the `IN_PROGRESS` test exercises the loop; keep `POLL_ATTEMPTS` reachable by stubbing timers if that test becomes slow:

```ts
vi.useFakeTimers({ shouldAdvanceTime: true });
```

- [ ] **Step 4: Register it**

```ts
// in src/lib/publish/publisher-registry.ts
import { instagramPublisher } from './instagram/instagram-publisher';

registerPublisher(instagramPublisher);
```

- [ ] **Step 5: Raise the publish-target timeout**

Instagram polling can take a minute. In `src/logic-functions/publish-target.logic-function.ts`, change:

```ts
  timeoutSeconds: 120,
```

to:

```ts
  // Instagram containers are polled inline for up to 60 seconds.
  timeoutSeconds: 180,
```

- [ ] **Step 6: Run and commit**

```bash
yarn test:unit && yarn lint && git add -A && git commit -m "feat: add Instagram container publisher"
```

Expected: PASS, 8 new tests.

---

### Task 4: The container finisher

**Files:**
- Create: `src/logic-functions/instagram-finish-containers.logic-function.ts`
- Modify: `src/constants/universal-identifiers.ts`
- Test: `src/logic-functions/__tests__/instagram-finish-containers.test.ts`

**Interfaces:**
- Consumes: `getContainerStatus`, `publishContainer` (Task 2), `getAccountToken` (core Task 6).
- Produces: a cron function that settles targets left in `AWAITING_PLATFORM`.

- [ ] **Step 1: Add the UUID**

```ts
// append to src/constants/universal-identifiers.ts
export const INSTAGRAM_IDS = {
  finishContainers: 'REPLACE-IG1',
} as const;
```

- [ ] **Step 2: Write the failing test**

```ts
// src/logic-functions/__tests__/instagram-finish-containers.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, mutationMock, kvGetMock, getStatusMock, publishMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  kvGetMock: vi.fn(),
  getStatusMock: vi.fn(),
  publishMock: vi.fn(),
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

vi.mock('../../lib/publish/instagram/instagram-api', () => ({
  getContainerStatus: getStatusMock,
  publishContainer: publishMock,
  createMediaContainer: vi.fn(),
}));

import instagramFinishContainers from '../instagram-finish-containers.logic-function';

const handler = instagramFinishContainers.config.handler as () => Promise<{
  settled: number;
}>;

const pendingTarget = {
  id: 'target-1',
  externalPostId: 'container-1',
  socialAccount: { externalId: '178414' },
};

const dataOf = () =>
  mutationMock.mock.calls.find((call) => 'updateSocialPostTarget' in call[0])?.[0]
    .updateSocialPostTarget.__args.data;

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({
    socialPostTargets: { edges: [{ node: pendingTarget }] },
  });
  mutationMock.mockResolvedValue({});
  kvGetMock.mockResolvedValue('tok');
  getStatusMock.mockResolvedValue('FINISHED');
  publishMock.mockResolvedValue('media-9');
});

describe('instagram-finish-containers handler', () => {
  it('should publish a finished container and mark the target PUBLISHED', async () => {
    const result = await handler();

    expect(result.settled).toBe(1);
    expect(publishMock).toHaveBeenCalledWith('178414', 'container-1', 'tok');
    expect(dataOf()).toMatchObject({ status: 'PUBLISHED', externalPostId: 'media-9' });
  });

  it('should query only AWAITING_PLATFORM Instagram targets', async () => {
    await handler();

    expect(queryMock.mock.calls[0][0].socialPostTargets.__args.filter).toEqual({
      platform: { eq: 'INSTAGRAM' },
      status: { eq: 'AWAITING_PLATFORM' },
    });
  });

  it('should leave a still-processing container alone', async () => {
    getStatusMock.mockResolvedValue('IN_PROGRESS');

    const result = await handler();

    expect(result.settled).toBe(0);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it('should fail the target when the container errored', async () => {
    getStatusMock.mockResolvedValue('ERROR');

    await handler();

    expect(dataOf()).toMatchObject({ status: 'FAILED' });
    expect(dataOf().errorMessage).toContain('ERROR');
  });

  it('should fail the target when its token is gone', async () => {
    kvGetMock.mockResolvedValue(null);

    await handler();

    expect(dataOf()).toMatchObject({ status: 'FAILED' });
    expect(dataOf().errorMessage).toContain('No stored token');
  });

  it('should do nothing when nothing is awaiting', async () => {
    queryMock.mockResolvedValue({ socialPostTargets: { edges: [] } });

    expect(await handler()).toEqual({ settled: 0 });
  });
});
```

- [ ] **Step 3: Run it to verify it fails, then write the function**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../instagram-finish-containers.logic-function`.

```ts
// src/logic-functions/instagram-finish-containers.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { INSTAGRAM_IDS } from '../constants/universal-identifiers';
import { getAccountToken } from '../lib/accounts/account-token-store';
import { getContainerStatus, publishContainer } from '../lib/publish/instagram/instagram-api';
import { SocialPlatform } from '../lib/publish/social-platform';

const EVERY_TWO_MINUTES = '*/2 * * * *';

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
        filter: { platform: { eq: 'INSTAGRAM' }, status: { eq: 'AWAITING_PLATFORM' } },
        first: 50,
      },
      edges: {
        node: { id: true, externalPostId: true, socialAccount: { externalId: true } },
      },
    },
  })) as { socialPostTargets?: { edges?: { node: AwaitingTarget }[] } };

  const targets = found.socialPostTargets?.edges ?? [];
  let settled = 0;

  const settle = async (targetId: string, data: Record<string, unknown>) => {
    await client.mutation({
      updateSocialPostTarget: { __args: { id: targetId, data }, id: true },
    });
    settled += 1;
  };

  for (const edge of targets) {
    const target = edge.node;
    const token = await getAccountToken(
      SocialPlatform.INSTAGRAM,
      target.socialAccount.externalId,
    );

    if (token === null) {
      await settle(target.id, {
        status: 'FAILED',
        errorMessage: `No stored token for Instagram account ${target.socialAccount.externalId}`,
      });
      continue;
    }

    const status = await getContainerStatus(target.externalPostId, token);

    if (status === 'IN_PROGRESS') {
      continue;
    }

    if (status === 'ERROR' || status === 'EXPIRED') {
      await settle(target.id, {
        status: 'FAILED',
        errorMessage: `Instagram container ${target.externalPostId} reported ${status}`,
      });
      continue;
    }

    try {
      const mediaId = await publishContainer(
        target.socialAccount.externalId,
        target.externalPostId,
        token,
      );

      await settle(target.id, {
        status: 'PUBLISHED',
        externalPostId: mediaId,
        permalink: `https://www.instagram.com/p/${mediaId}`,
        publishedAt: new Date().toISOString(),
        errorMessage: null,
      });
    } catch (error) {
      await settle(target.id, {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Instagram publish failed',
      });
    }
  }

  return { settled };
};

export default defineLogicFunction({
  universalIdentifier: INSTAGRAM_IDS.finishContainers,
  name: 'instagram-finish-containers',
  description:
    'Settles Instagram targets whose media container was still processing when publish-target ran.',
  timeoutSeconds: 300,
  handler,
  cronTriggerSettings: { pattern: EVERY_TWO_MINUTES },
});
```

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add Instagram container finisher cron"
```

Expected: PASS, 6 tests.

---

### Task 5: Verify against a real account

**Files:** none.

- [ ] **Step 1: Reconnect Meta**

Disconnect and reconnect the Meta connection so `onConnect` runs the new Instagram discovery.

Expected: a Social Account with `platform: INSTAGRAM` and handle matching your IG username. If not, the Page has no linked Instagram Business account, or `instagram_basic` was not granted.

- [ ] **Step 2: Publish an image**

Create a Social Post with a body under 2200 characters and one **publicly reachable https** image URL, status `SCHEDULED`, `scheduledAt` in the past.

```bash
yarn twenty dev:function:exec -n publish-due-posts -p '{}'
yarn twenty dev:function:logs
```

Expected: the Instagram target reaches `PUBLISHED` with a media id, and the post appears on the account.

The most common failure is `Media download failed`, which means Instagram could not fetch the URL. It must be public, https, and not behind a redirect chain.

- [ ] **Step 3: Publish a Reel**

Same, with an `.mp4` URL.

Expected: either `PUBLISHED` after inline polling, or `AWAITING_PLATFORM` followed by `PUBLISHED` within two minutes once the finisher cron runs.

- [ ] **Step 4: Full check and commit**

```bash
yarn lint && yarn typecheck && yarn test:unit
git add -A && git commit -m "docs: record Instagram verification steps"
```

---

## Definition of done

- All unit tests pass. 29 new tests across Tasks 1 to 4.
- Reconnecting Meta creates an `INSTAGRAM` Social Account for each Page with a linked Business account.
- An image post reaches `PUBLISHED` inline and appears on Instagram.
- A Reel either publishes inline or is settled by the finisher cron within two minutes.
- A post with no media is rejected by the core validator with `INSTAGRAM requires at least one media URL`, without any API call.

## Known limitations, each a follow-up

- **Single media only.** Carousels need `CAROUSEL` containers with children.
- **No Stories.** `media_type: STORIES` is a small addition once feed posting is proven.
- **No 100-per-24h guard.** The account limit is not tracked locally, so exceeding it surfaces as a Meta error rather than a pre-flight rejection.
- **Permalink is synthesised** from the media id, which is not the real shortcode URL. Fetching `permalink` from the media object is a follow-up.
