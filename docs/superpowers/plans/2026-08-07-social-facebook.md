# Facebook Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** `2026-08-07-social-core.md` must be complete. This plan adds files to the same `twenty-social` app and changes nothing in the core except one registration line and the `serverVariables` block.

**Goal:** Publish to Facebook Pages, and ingest Lead Ads submissions into the CRM within seconds of a form being filled in.

**Architecture:** A Meta OAuth connection provider; an `onConnect` hook that exchanges the short-lived user token for a long-lived one, enumerates the user's Pages, and stores a non-expiring Page token per Page; a `SocialPublisher` for Page feed and photo posts; and a Lead Ads pipeline built on Twenty's `serverRouteTriggerSettings`, because Meta delivers every tenant's webhook to one URL.

**Tech Stack:** Meta Graph API v25.0, `twenty-sdk`, Vitest 4.

## Global Constraints

- Graph API version is pinned in one constant. Never inline a version string.
- `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` are `serverVariables` with `isSecret: true`, entered at **Settings → Admin Panel → Apps → Social**.
- Webhook signature verification happens in the **resolver**, before any side effect, using a constant-time comparison. Never in the target.
- Page access tokens are stored via `setAccountToken` from the core, never on a record field.
- The Lead Ads target handler must be idempotent. Meta redelivers.

## Platform prerequisites, start these first

These gate the plan and take weeks. Nothing below can be verified against real data until they land.

| Requirement | Why | Typical time |
|---|---|---|
| Meta Business Verification | Required before any advanced permission is granted | 1-3 weeks |
| App Review: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` | Page publishing | 1-2 weeks |
| App Review: `pages_manage_metadata` | Webhook subscription | with the above |
| App Review: `leads_retrieval`, `ads_management` | Reading Lead Ads submissions | 2-4 weeks |

**You can build and test everything here before approval** using a Meta app in Development mode against a Page you administer. Development mode grants the advanced permissions to app admins only. Do that; do not wait.

---

## How Lead Ads routing works

Meta posts every subscribed Page's `leadgen` events to a single callback URL. Twenty's `httpRouteTriggerSettings` resolves the workspace from the request host, which Meta cannot vary. So this uses `serverRouteTriggerSettings`:

```
Meta  ──POST /webhooks/server/{resolverUUID}──▶  resolver (owner workspace)
                                                  │ verify X-Hub-Signature-256
                                                  │ kv.get('meta:page:{page_id}', SERVER)
                                                  ▼
                                          { workspaceId, target: ingest-lead }
                                                  │  platform acks 202
                                                  ▼
                                    ingest-lead runs in the resolved workspace
```

The `page_id` to `workspaceId` mapping is a `SERVER`-scoped key-value claim written at connect time. A workspace can only claim a page id for itself and cannot overwrite another workspace's claim, so one tenant cannot hijack another's Page.

**The application must be claimed and installed on its owner workspace** for a server route to dispatch at all.

---

### Task 1: Meta connection provider and server variables

**Files:**
- Create: `src/connection-providers/meta.connection-provider.ts`
- Modify: `src/application-config.ts`
- Modify: `src/constants/universal-identifiers.ts`

**Interfaces:**
- Produces: a connection provider named `meta`, and `META_IDS` with the UUIDs this plan needs.

- [ ] **Step 1: Generate UUIDs and extend the constants**

```bash
for i in $(seq 1 8); do uuidgen | tr '[:upper:]' '[:lower:]'; done
```

```ts
// append to src/constants/universal-identifiers.ts
export const META_IDS = {
  connectionProvider: 'REPLACE-M1',
  onConnect: 'REPLACE-M2',
  onDisconnect: 'REPLACE-M3',
  leadgenResolver: 'REPLACE-M4',
  ingestLead: 'REPLACE-M5',
} as const;
```

- [ ] **Step 2: Write the connection provider**

```ts
// src/connection-providers/meta.connection-provider.ts
import { defineConnectionProvider } from 'twenty-sdk/define';

import { META_IDS } from '../constants/universal-identifiers';
import { GRAPH_API_VERSION } from '../lib/publish/facebook/graph-api-version';

export default defineConnectionProvider({
  universalIdentifier: META_IDS.connectionProvider,
  name: 'meta',
  displayName: 'Meta (Facebook & Instagram)',
  type: 'oauth',
  oauthConfig: {
    authorizationEndpoint: `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`,
    tokenEndpoint: `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`,
    // Instagram scopes are included here so the Instagram plan needs no
    // reconnect. Meta grants only what App Review has approved.
    scopes: [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'pages_manage_metadata',
      'leads_retrieval',
      'ads_management',
      'instagram_basic',
      'instagram_content_publish',
    ],
    clientIdVariable: 'META_APP_ID',
    clientSecretVariable: 'META_APP_SECRET',
    tokenRequestContentType: 'form',
    usePkce: false,
  },
  onConnectLogicFunction: { universalIdentifier: META_IDS.onConnect },
  onDisconnectLogicFunction: { universalIdentifier: META_IDS.onDisconnect },
});
```

- [ ] **Step 3: Add the server variables**

```ts
// in src/application-config.ts, inside serverVariables
    META_APP_ID: {
      description: 'Meta app ID from developers.facebook.com. Not secret, but instance-scoped.',
      isSecret: false,
      isRequired: false,
    },
    META_APP_SECRET: {
      description:
        'Meta app secret. Used for the long-lived token exchange and to verify X-Hub-Signature-256 on Lead Ads webhooks.',
      isSecret: true,
      isRequired: false,
    },
    META_WEBHOOK_VERIFY_TOKEN: {
      description:
        'Arbitrary string you also enter in the Meta webhook configuration. Meta echoes it during the subscription handshake.',
      isSecret: true,
      isRequired: false,
    },
```

`isRequired` stays false so the app still installs on instances that do not use Facebook.

- [ ] **Step 4: Write the version constant**

```ts
// src/lib/publish/facebook/graph-api-version.ts

// Pinned deliberately. Meta deprecates versions on a ~2 year cycle;
// bumping this is a reviewed change, not a silent drift.
export const GRAPH_API_VERSION = 'v25.0';
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
```

- [ ] **Step 5: Sync and commit**

```bash
yarn twenty apply
git add -A && git commit -m "feat: add Meta OAuth connection provider"
```

Expected: at **Settings → Admin Panel → Apps → Social** the three Meta variables appear, and a **Meta** connection becomes available in the app's connections section.

---

### Task 2: Token exchange

**Files:**
- Create: `src/lib/publish/facebook/exchange-tokens.ts`
- Test: `src/lib/publish/facebook/__tests__/exchange-tokens.test.ts`

**Interfaces:**
- Produces: `exchangeForLongLivedUserToken({ shortLivedToken, appId, appSecret })` and `listPagesWithTokens(longLivedUserToken)`. Task 3 calls both.

The token model, which is easy to get wrong:

| Token | Lifetime |
|---|---|
| Short-lived user token, from the OAuth callback | ~1 hour |
| Long-lived user token, after exchange | ~60 days |
| **Page token derived from a long-lived user token** | **Does not expire** |

Because Page tokens do not expire, there is no refresh cron in this plan. The only reason to re-run the exchange is a permission change or a user password reset.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/facebook/__tests__/exchange-tokens.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exchangeForLongLivedUserToken, listPagesWithTokens } from '../exchange-tokens';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeForLongLivedUserToken', () => {
  it('should call the oauth endpoint with fb_exchange_token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'long-lived', expires_in: 5184000 }),
    });

    const token = await exchangeForLongLivedUserToken({
      shortLivedToken: 'short',
      appId: 'app-1',
      appSecret: 'secret-1',
    });

    expect(token).toBe('long-lived');

    const url = new URL(fetchMock.mock.calls[0][0]);

    expect(url.pathname).toContain('/oauth/access_token');
    expect(url.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(url.searchParams.get('client_id')).toBe('app-1');
    expect(url.searchParams.get('client_secret')).toBe('secret-1');
    expect(url.searchParams.get('fb_exchange_token')).toBe('short');
  });

  it('should throw with Meta error detail on failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Invalid token"}}',
    });

    await expect(
      exchangeForLongLivedUserToken({
        shortLivedToken: 'bad',
        appId: 'app-1',
        appSecret: 'secret-1',
      }),
    ).rejects.toThrow('Meta token exchange failed with 400: {"error":{"message":"Invalid token"}}');
  });
});

describe('listPagesWithTokens', () => {
  it('should return each page with its id, name and token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: '111', name: 'Praxis Meier', access_token: 'page-tok-1' },
          { id: '222', name: 'Second Page', access_token: 'page-tok-2' },
        ],
      }),
    });

    const pages = await listPagesWithTokens('long-lived');

    expect(pages).toEqual([
      { id: '111', name: 'Praxis Meier', accessToken: 'page-tok-1' },
      { id: '222', name: 'Second Page', accessToken: 'page-tok-2' },
    ]);
  });

  it('should request the id, name and access_token fields', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    await listPagesWithTokens('long-lived');

    const url = new URL(fetchMock.mock.calls[0][0]);

    expect(url.pathname).toContain('/me/accounts');
    expect(url.searchParams.get('fields')).toBe('id,name,access_token');
    expect(url.searchParams.get('access_token')).toBe('long-lived');
  });

  it('should return an empty array when the user administers no page', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    expect(await listPagesWithTokens('long-lived')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../exchange-tokens`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/publish/facebook/exchange-tokens.ts
import { GRAPH_API_BASE } from './graph-api-version';

export type FacebookPage = {
  id: string;
  name: string;
  accessToken: string;
};

const failIfNotOk = async (response: Response, label: string): Promise<void> => {
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }
};

// Must run server-side: it carries the app secret.
export const exchangeForLongLivedUserToken = async ({
  shortLivedToken,
  appId,
  appSecret,
}: {
  shortLivedToken: string;
  appId: string;
  appSecret: string;
}): Promise<string> => {
  const url = new URL(`${GRAPH_API_BASE}/oauth/access_token`);

  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', shortLivedToken);

  const response = await fetch(url.toString());

  await failIfNotOk(response, 'Meta token exchange');

  const payload = (await response.json()) as { access_token: string };

  return payload.access_token;
};

// Page tokens derived from a long-lived user token do not expire.
export const listPagesWithTokens = async (
  longLivedUserToken: string,
): Promise<FacebookPage[]> => {
  const url = new URL(`${GRAPH_API_BASE}/me/accounts`);

  url.searchParams.set('fields', 'id,name,access_token');
  url.searchParams.set('access_token', longLivedUserToken);

  const response = await fetch(url.toString());

  await failIfNotOk(response, 'Meta page listing');

  const payload = (await response.json()) as {
    data?: { id: string; name: string; access_token: string }[];
  };

  return (payload.data ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
  }));
};
```

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add Meta long-lived token exchange"
```

Expected: PASS, 5 tests.

---

### Task 3: The onConnect hook

**Files:**
- Create: `src/logic-functions/meta-on-connect.logic-function.ts`
- Create: `src/logic-functions/meta-on-disconnect.logic-function.ts`
- Test: `src/logic-functions/__tests__/meta-on-connect.test.ts`

**Interfaces:**
- Consumes: `exchangeForLongLivedUserToken`, `listPagesWithTokens` (Task 2), `setAccountToken` (core Task 6).
- Produces: `SocialAccount` records with `platform: FACEBOOK`, per-Page tokens in the app kv, and `SERVER`-scoped `meta:page:{pageId}` claims that Task 5's resolver reads.

- [ ] **Step 1: Write the failing test**

```ts
// src/logic-functions/__tests__/meta-on-connect.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  mutationMock,
  kvSetMock,
  getConnectionMock,
  exchangeMock,
  listPagesMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  kvSetMock: vi.fn(),
  getConnectionMock: vi.fn(),
  exchangeMock: vi.fn(),
  listPagesMock: vi.fn(),
}));

vi.mock('twenty-client-sdk/core', () => ({
  CoreApiClient: vi.fn(function () {
    return { query: queryMock, mutation: mutationMock };
  }),
}));

vi.mock('twenty-sdk/logic-function', () => ({
  kv: { get: vi.fn(), set: kvSetMock, delete: vi.fn() },
  getConnection: getConnectionMock,
  enqueueJob: vi.fn(),
}));

vi.mock('../../lib/publish/facebook/exchange-tokens', () => ({
  exchangeForLongLivedUserToken: exchangeMock,
  listPagesWithTokens: listPagesMock,
}));

import metaOnConnect from '../meta-on-connect.logic-function';

const handler = metaOnConnect.config.handler as (payload: {
  connectionId: string;
  workspaceId: string;
}) => Promise<{ accountsLinked: number }>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_APP_ID = 'app-1';
  process.env.META_APP_SECRET = 'secret-1';

  getConnectionMock.mockResolvedValue({ id: 'conn-1', accessToken: 'short-lived' });
  exchangeMock.mockResolvedValue('long-lived');
  listPagesMock.mockResolvedValue([
    { id: '111', name: 'Praxis Meier', accessToken: 'page-tok-1' },
  ]);
  queryMock.mockResolvedValue({ socialAccounts: { edges: [] } });
  mutationMock.mockResolvedValue({ createSocialAccount: { id: 'acct-new' } });
});

describe('meta-on-connect handler', () => {
  it('should create a SocialAccount for each page', async () => {
    const result = await handler({ connectionId: 'conn-1', workspaceId: 'ws-1' });

    expect(result.accountsLinked).toBe(1);

    const data = mutationMock.mock.calls.find((call) => 'createSocialAccount' in call[0])?.[0]
      .createSocialAccount.__args.data;

    expect(data.platform).toBe('FACEBOOK');
    expect(data.externalId).toBe('111');
    expect(data.handle).toBe('Praxis Meier');
    expect(data.isActive).toBe(true);
    // Page tokens do not expire.
    expect(data.tokenExpiresAt).toBeNull();
  });

  it('should store the page token in the app key-value store', async () => {
    await handler({ connectionId: 'conn-1', workspaceId: 'ws-1' });

    expect(kvSetMock).toHaveBeenCalledWith('token:FACEBOOK:111', 'page-tok-1');
  });

  it('should claim the page id at server scope for webhook routing', async () => {
    await handler({ connectionId: 'conn-1', workspaceId: 'ws-1' });

    expect(kvSetMock).toHaveBeenCalledWith('meta:page:111', undefined, { scope: 'SERVER' });
  });

  it('should update rather than duplicate an existing account', async () => {
    queryMock.mockResolvedValue({
      socialAccounts: { edges: [{ node: { id: 'acct-existing', externalId: '111' } }] },
    });

    await handler({ connectionId: 'conn-1', workspaceId: 'ws-1' });

    expect(mutationMock.mock.calls.some((call) => 'createSocialAccount' in call[0])).toBe(false);

    const update = mutationMock.mock.calls.find((call) => 'updateSocialAccount' in call[0]);

    expect(update?.[0].updateSocialAccount.__args.id).toBe('acct-existing');
  });

  it('should tolerate a page id already claimed by this workspace', async () => {
    kvSetMock.mockImplementation(async (key: string) => {
      if (key === 'meta:page:111') {
        throw new Error('already claimed');
      }
    });

    const result = await handler({ connectionId: 'conn-1', workspaceId: 'ws-1' });

    expect(result.accountsLinked).toBe(1);
  });

  it('should throw when the app credentials are not configured', async () => {
    delete process.env.META_APP_SECRET;

    await expect(handler({ connectionId: 'conn-1', workspaceId: 'ws-1' })).rejects.toThrow(
      'META_APP_ID and META_APP_SECRET must be configured',
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../meta-on-connect.logic-function`.

- [ ] **Step 3: Write the hook**

```ts
// src/logic-functions/meta-on-connect.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { getConnection, kv } from 'twenty-sdk/logic-function';

import { META_IDS } from '../constants/universal-identifiers';
import { setAccountToken } from '../lib/accounts/account-token-store';
import {
  exchangeForLongLivedUserToken,
  listPagesWithTokens,
} from '../lib/publish/facebook/exchange-tokens';
import { SocialPlatform } from '../lib/publish/social-platform';

const handler = async (payload: { connectionId: string; workspaceId: string }) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error(
      'META_APP_ID and META_APP_SECRET must be configured at Settings > Admin Panel > Apps',
    );
  }

  const connection = await getConnection(payload.connectionId);

  if (!connection) {
    throw new Error(`Connection ${payload.connectionId} not found`);
  }

  const longLivedToken = await exchangeForLongLivedUserToken({
    shortLivedToken: connection.accessToken,
    appId,
    appSecret,
  });

  const pages = await listPagesWithTokens(longLivedToken);
  const client = new CoreApiClient();

  for (const page of pages) {
    await setAccountToken(SocialPlatform.FACEBOOK, page.id, page.accessToken);

    // Server-scoped claim so the Lead Ads resolver, which runs in the
    // owner workspace, can map an inbound page_id back to this workspace.
    // Throws if another workspace already owns it, which is the desired
    // behaviour; a re-claim by the same workspace is a no-op we ignore.
    try {
      await kv.set(`meta:page:${page.id}`, undefined, { scope: 'SERVER' });
    } catch {
      // Already claimed. Either by us, which is fine, or by another
      // workspace, in which case webhooks keep routing there and the
      // operator has to unlink it first.
    }

    const existing = (await client.query({
      socialAccounts: {
        __args: {
          filter: { platform: { eq: 'FACEBOOK' }, externalId: { eq: page.id } },
          first: 1,
        },
        edges: { node: { id: true, externalId: true } },
      },
    })) as { socialAccounts?: { edges?: { node: { id: string } }[] } };

    const existingId = existing.socialAccounts?.edges?.[0]?.node.id;

    const data = {
      name: page.name,
      platform: 'FACEBOOK',
      externalId: page.id,
      handle: page.name,
      isActive: true,
      connectedAt: new Date().toISOString(),
      // Page tokens derived from a long-lived user token never expire.
      tokenExpiresAt: null,
    };

    if (existingId) {
      await client.mutation({
        updateSocialAccount: { __args: { id: existingId, data }, id: true },
      });
    } else {
      await client.mutation({
        createSocialAccount: { __args: { data }, id: true },
      });
    }
  }

  return { accountsLinked: pages.length };
};

export default defineLogicFunction({
  universalIdentifier: META_IDS.onConnect,
  name: 'meta-on-connect',
  description: 'Exchanges the Meta token and links every administered Page as a SocialAccount.',
  timeoutSeconds: 120,
  handler,
});
```

- [ ] **Step 4: Write the disconnect hook**

```ts
// src/logic-functions/meta-on-disconnect.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { META_IDS } from '../constants/universal-identifiers';

// Deactivates rather than deletes: the SocialPostTarget history stays
// readable, and reconnecting flips the accounts back on.
const handler = async () => {
  const client = new CoreApiClient();

  const accounts = (await client.query({
    socialAccounts: {
      __args: { filter: { platform: { eq: 'FACEBOOK' } }, first: 200 },
      edges: { node: { id: true } },
    },
  })) as { socialAccounts?: { edges?: { node: { id: string } }[] } };

  for (const edge of accounts.socialAccounts?.edges ?? []) {
    await client.mutation({
      updateSocialAccount: {
        __args: { id: edge.node.id, data: { isActive: false } },
        id: true,
      },
    });
  }

  return { deactivated: accounts.socialAccounts?.edges?.length ?? 0 };
};

export default defineLogicFunction({
  universalIdentifier: META_IDS.onDisconnect,
  name: 'meta-on-disconnect',
  description: 'Deactivates Facebook SocialAccounts when the Meta connection is removed.',
  timeoutSeconds: 60,
  handler,
});
```

- [ ] **Step 5: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add Meta connect and disconnect hooks"
```

Expected: PASS, 6 tests.

---

### Task 4: The Facebook publisher

**Files:**
- Create: `src/lib/publish/facebook/facebook-publisher.ts`
- Modify: `src/lib/publish/publisher-registry.ts`
- Test: `src/lib/publish/facebook/__tests__/facebook-publisher.test.ts`

**Interfaces:**
- Consumes: `SocialPublisher`, `PublishInput`, `PublishResult`, `SocialPlatform` (core Task 4).
- Produces: `facebookPublisher`, registered for `SocialPlatform.FACEBOOK`.

Two endpoints, chosen by whether media is present:

| Case | Endpoint | Body | Response |
|---|---|---|---|
| Text only | `POST /{page_id}/feed` | `message` | `{ id }` |
| With image | `POST /{page_id}/photos` | `url`, `caption` | `{ id, post_id }` |

The photo response's `post_id` is the feed post; `id` is the photo. Record `post_id`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/facebook/__tests__/facebook-publisher.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { facebookPublisher } from '../facebook-publisher';

const fetchMock = vi.fn();

const input = {
  body: 'Hello from Twenty',
  mediaUrls: [] as string[],
  accountExternalId: '111',
  accessToken: 'page-tok-1',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('facebookPublisher', () => {
  it('should declare the FACEBOOK platform and its limits', () => {
    expect(facebookPublisher.platform).toBe('FACEBOOK');
    expect(facebookPublisher.requiresMedia).toBe(false);
    expect(facebookPublisher.maxBodyLength).toBe(63_206);
  });

  it('should post text to the page feed endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: '111_999' }) });

    const result = await facebookPublisher.publish(input);

    expect(result).toEqual({
      status: 'PUBLISHED',
      externalPostId: '111_999',
      permalink: 'https://www.facebook.com/111_999',
    });

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toContain('/111/feed');
    expect(init.method).toBe('POST');

    const body = new URLSearchParams(init.body as string);

    expect(body.get('message')).toBe('Hello from Twenty');
    expect(body.get('access_token')).toBe('page-tok-1');
  });

  it('should post to the photos endpoint when media is present', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'photo-1', post_id: '111_888' }),
    });

    const result = await facebookPublisher.publish({
      ...input,
      mediaUrls: ['https://cdn.example.com/a.jpg'],
    });

    // post_id is the feed post; id is only the photo.
    expect(result).toEqual({
      status: 'PUBLISHED',
      externalPostId: '111_888',
      permalink: 'https://www.facebook.com/111_888',
    });

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toContain('/111/photos');

    const body = new URLSearchParams(init.body as string);

    expect(body.get('url')).toBe('https://cdn.example.com/a.jpg');
    expect(body.get('caption')).toBe('Hello from Twenty');
  });

  it('should fall back to id when the photo response omits post_id', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'photo-1' }) });

    const result = await facebookPublisher.publish({
      ...input,
      mediaUrls: ['https://cdn.example.com/a.jpg'],
    });

    expect(result.status === 'PUBLISHED' && result.externalPostId).toBe('photo-1');
  });

  it('should return FAILED with the Meta error message on rejection', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        '{"error":{"message":"(#200) Requires pages_manage_posts permission"}}',
    });

    const result = await facebookPublisher.publish(input);

    expect(result).toEqual({
      status: 'FAILED',
      error: 'Facebook rejected the post with 403: (#200) Requires pages_manage_posts permission',
    });
  });

  it('should include the raw body when the error is not Meta-shaped', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'gateway down' });

    const result = await facebookPublisher.publish(input);

    expect(result).toEqual({
      status: 'FAILED',
      error: 'Facebook rejected the post with 500: gateway down',
    });
  });

  it('should return FAILED rather than throw on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const result = await facebookPublisher.publish(input);

    expect(result).toEqual({ status: 'FAILED', error: 'ECONNRESET' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../facebook-publisher`.

- [ ] **Step 3: Write the adapter**

```ts
// src/lib/publish/facebook/facebook-publisher.ts
import { type PublishInput, type PublishResult, type SocialPublisher } from '../publisher.type';
import { SocialPlatform } from '../social-platform';
import { GRAPH_API_BASE } from './graph-api-version';

// Facebook's documented post character ceiling.
const MAX_BODY_LENGTH = 63_206;

const extractMetaError = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };

    return parsed.error?.message ?? raw;
  } catch {
    return raw;
  }
};

const publish = async (input: PublishInput): Promise<PublishResult> => {
  const hasMedia = input.mediaUrls.length > 0;
  const endpoint = hasMedia
    ? `${GRAPH_API_BASE}/${input.accountExternalId}/photos`
    : `${GRAPH_API_BASE}/${input.accountExternalId}/feed`;

  const form = new URLSearchParams();

  form.set('access_token', input.accessToken);

  if (hasMedia) {
    form.set('url', input.mediaUrls[0]);
    form.set('caption', input.body);
  } else {
    form.set('message', input.body);
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!response.ok) {
      return {
        status: 'FAILED',
        error: `Facebook rejected the post with ${response.status}: ${extractMetaError(await response.text())}`,
      };
    }

    const payload = (await response.json()) as { id: string; post_id?: string };
    // On /photos, post_id is the feed story; id is only the photo object.
    const externalPostId = payload.post_id ?? payload.id;

    return {
      status: 'PUBLISHED',
      externalPostId,
      permalink: `https://www.facebook.com/${externalPostId}`,
    };
  } catch (error) {
    return {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'Facebook publish failed',
    };
  }
};

export const facebookPublisher: SocialPublisher = {
  platform: SocialPlatform.FACEBOOK,
  maxBodyLength: MAX_BODY_LENGTH,
  requiresMedia: false,
  publish,
};
```

Only the first media URL is used. Multi-photo posts need the unpublished-photo then feed-attachment flow, which is a follow-up.

- [ ] **Step 4: Register it**

```ts
// at the bottom of src/lib/publish/publisher-registry.ts, after the dry-run line
import { facebookPublisher } from './facebook/facebook-publisher';

registerPublisher(facebookPublisher);
```

Move both imports to the top of the file to satisfy the linter; only the `registerPublisher` calls stay at the bottom.

- [ ] **Step 5: Run and commit**

```bash
yarn test:unit && yarn lint && git add -A && git commit -m "feat: add Facebook page publisher"
```

Expected: PASS, 7 new tests. The core's `platform-parity` and registry tests still pass because `resetRegistry()` clears both registrations.

---

### Task 5: Lead Ads webhook resolver

**Files:**
- Create: `src/logic-functions/meta-leadgen-resolver.logic-function.ts`
- Test: `src/logic-functions/__tests__/meta-leadgen-resolver.test.ts`

**Interfaces:**
- Produces: a server-route resolver reachable at `POST /webhooks/server/{META_IDS.leadgenResolver}`, dispatching to `META_IDS.ingestLead`.

- [ ] **Step 1: Write the failing test**

```ts
// src/logic-functions/__tests__/meta-leadgen-resolver.test.ts
import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { kvGetMock } = vi.hoisted(() => ({ kvGetMock: vi.fn() }));

vi.mock('twenty-sdk/logic-function', async () => {
  const actual = await vi.importActual<typeof import('twenty-sdk/logic-function')>(
    'twenty-sdk/logic-function',
  );

  return { ...actual, kv: { get: kvGetMock, set: vi.fn(), delete: vi.fn() } };
});

import metaLeadgenResolver from '../meta-leadgen-resolver.logic-function';

const handler = metaLeadgenResolver.config.handler as (event: unknown) => Promise<unknown>;

const SECRET = 'app-secret';

const signedEvent = (body: unknown, secret = SECRET) => {
  const rawBody = JSON.stringify(body);

  return {
    rawBody,
    body,
    headers: {
      'x-hub-signature-256':
        'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'),
    },
    queryStringParameters: {},
    requestContext: { http: { method: 'POST', path: '/webhooks/server/x' } },
  };
};

const leadgenBody = {
  object: 'page',
  entry: [
    {
      id: '111',
      time: 1440120384,
      changes: [
        {
          field: 'leadgen',
          value: {
            leadgen_id: '123123',
            page_id: '111',
            form_id: '555',
            created_time: 1440120384,
          },
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.META_APP_SECRET = SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-me';
  kvGetMock.mockResolvedValue('ws-1');
});

describe('meta-leadgen-resolver', () => {
  it('should echo the challenge on the subscription handshake', async () => {
    const result = (await handler({
      rawBody: '',
      body: null,
      headers: {},
      queryStringParameters: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-me',
        'hub.challenge': '1158201444',
      },
      requestContext: { http: { method: 'GET', path: '/webhooks/server/x' } },
    })) as { body: string };

    expect(result.body).toBe('1158201444');
  });

  it('should reject a handshake with the wrong verify token', async () => {
    await expect(
      handler({
        rawBody: '',
        body: null,
        headers: {},
        queryStringParameters: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong',
          'hub.challenge': '1158201444',
        },
        requestContext: { http: { method: 'GET', path: '/webhooks/server/x' } },
      }),
    ).rejects.toThrow('invalid verify token');
  });

  it('should dispatch a valid leadgen event to the resolved workspace', async () => {
    const result = await handler(signedEvent(leadgenBody));

    expect(result).toEqual({
      workspaceId: 'ws-1',
      targetLogicFunctionUniversalIdentifier: expect.any(String),
      payload: { leadgenId: '123123', pageId: '111', formId: '555', createdTime: 1440120384 },
    });
  });

  it('should reject a forged signature', async () => {
    await expect(handler(signedEvent(leadgenBody, 'wrong-secret'))).rejects.toThrow(
      'invalid signature',
    );
  });

  it('should reject when the app secret is not configured', async () => {
    delete process.env.META_APP_SECRET;

    await expect(handler(signedEvent(leadgenBody))).rejects.toThrow(
      'META_APP_SECRET is not configured',
    );
  });

  it('should reject an unclaimed page id', async () => {
    kvGetMock.mockResolvedValue(null);

    await expect(handler(signedEvent(leadgenBody))).rejects.toThrow(
      'page 111 is not linked to any workspace',
    );
  });

  it('should ignore a non-leadgen change', async () => {
    const result = (await handler(
      signedEvent({
        object: 'page',
        entry: [{ id: '111', time: 1, changes: [{ field: 'feed', value: {} }] }],
      }),
    )) as { body: string };

    expect(result.body).toBe('ignored');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../meta-leadgen-resolver.logic-function`.

- [ ] **Step 3: Write the resolver**

```ts
// src/logic-functions/meta-leadgen-resolver.logic-function.ts
import { createHmac, timingSafeEqual } from 'crypto';

import { defineLogicFunction } from 'twenty-sdk/define';
import { kv, Response, type RoutePayload } from 'twenty-sdk/logic-function';

import { META_IDS } from '../constants/universal-identifiers';

type LeadgenValue = {
  leadgen_id: string;
  page_id: string;
  form_id: string;
  created_time: number;
};

type WebhookBody = {
  object?: string;
  entry?: { id: string; time: number; changes?: { field: string; value: LeadgenValue }[] }[];
};

const assertValidSignature = (event: RoutePayload, secret: string): void => {
  const provided = event.headers['x-hub-signature-256'] ?? '';
  const expected =
    'sha256=' + createHmac('sha256', secret).update(event.rawBody ?? '').digest('hex');

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('invalid signature');
  }
};

const handler = async (event: RoutePayload) => {
  const query = event.queryStringParameters ?? {};

  // Meta's subscription handshake is a GET that must echo hub.challenge
  // on the same response, so it cannot go through the dispatch path.
  if (query['hub.mode'] === 'subscribe') {
    const expectedToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

    if (!expectedToken || query['hub.verify_token'] !== expectedToken) {
      throw new Error('invalid verify token');
    }

    return new Response(query['hub.challenge'] ?? '', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const secret = process.env.META_APP_SECRET;

  // Fail closed. An empty key would let any caller forge a signature.
  if (!secret) {
    throw new Error('META_APP_SECRET is not configured');
  }

  assertValidSignature(event, secret);

  const body = (event.body ?? {}) as WebhookBody;
  const change = body.entry?.[0]?.changes?.find((entry) => entry.field === 'leadgen');

  if (!change) {
    return new Response('ignored', { status: 200, headers: { 'content-type': 'text/plain' } });
  }

  const value = change.value;
  const workspaceId = await kv.get<string>(`meta:page:${value.page_id}`, { scope: 'SERVER' });

  if (!workspaceId) {
    throw new Error(`page ${value.page_id} is not linked to any workspace`);
  }

  return {
    workspaceId,
    targetLogicFunctionUniversalIdentifier: META_IDS.ingestLead,
    payload: {
      leadgenId: String(value.leadgen_id),
      pageId: String(value.page_id),
      formId: String(value.form_id),
      createdTime: value.created_time,
    },
  };
};

export default defineLogicFunction({
  universalIdentifier: META_IDS.leadgenResolver,
  name: 'meta-leadgen-resolver',
  description:
    'Verifies Meta Lead Ads webhooks and routes each to the workspace that owns the page.',
  timeoutSeconds: 15,
  handler,
  serverRouteTriggerSettings: {
    forwardedRequestHeaders: ['x-hub-signature-256'],
  },
});
```

Keep the resolver fast. Meta retries aggressively on a slow response, and the dispatch path acks `202` before the target runs, which is what you want here.

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add Meta Lead Ads webhook resolver"
```

Expected: PASS, 7 tests.

---

### Task 6: Lead ingestion

**Files:**
- Create: `src/lib/leads/fetch-lead.ts`
- Create: `src/lib/leads/map-field-data.ts`
- Create: `src/logic-functions/meta-ingest-lead.logic-function.ts`
- Test: `src/lib/leads/__tests__/map-field-data.test.ts`
- Test: `src/logic-functions/__tests__/meta-ingest-lead.test.ts`

**Interfaces:**
- Consumes: `getAccountToken` (core Task 6), `META_IDS.ingestLead`.
- Produces: `fetchLead(leadgenId, pageToken)`, `mapFieldData(fieldData)`, and the target logic function the resolver dispatches to.

- [ ] **Step 1: Write the failing mapper test**

```ts
// src/lib/leads/__tests__/map-field-data.test.ts
import { describe, expect, it } from 'vitest';

import { mapFieldData } from '../map-field-data';

describe('mapFieldData', () => {
  it('should map the standard Meta field names', () => {
    expect(
      mapFieldData([
        { name: 'email', values: ['joe@example.com'] },
        { name: 'full_name', values: ['Joe Example'] },
        { name: 'phone_number', values: ['+49 89 123456'] },
        { name: 'company_name', values: ['Example GmbH'] },
      ]),
    ).toEqual({
      email: 'joe@example.com',
      firstName: 'Joe',
      lastName: 'Example',
      phone: '+49 89 123456',
      companyName: 'Example GmbH',
      raw: {
        email: 'joe@example.com',
        full_name: 'Joe Example',
        phone_number: '+49 89 123456',
        company_name: 'Example GmbH',
      },
    });
  });

  it('should split a multi-word surname into the last name', () => {
    const mapped = mapFieldData([{ name: 'full_name', values: ['Anna Maria von Bergen'] }]);

    expect(mapped.firstName).toBe('Anna');
    expect(mapped.lastName).toBe('Maria von Bergen');
  });

  it('should prefer explicit first_name and last_name over full_name', () => {
    const mapped = mapFieldData([
      { name: 'full_name', values: ['Ignore Me'] },
      { name: 'first_name', values: ['Jane'] },
      { name: 'last_name', values: ['Doe'] },
    ]);

    expect(mapped.firstName).toBe('Jane');
    expect(mapped.lastName).toBe('Doe');
  });

  it('should keep every custom field in raw', () => {
    const mapped = mapFieldData([{ name: 'wieviele_mitarbeiter', values: ['11-50'] }]);

    expect(mapped.raw.wieviele_mitarbeiter).toBe('11-50');
    expect(mapped.email).toBeNull();
  });

  it('should tolerate an empty values array', () => {
    expect(mapFieldData([{ name: 'email', values: [] }]).email).toBeNull();
  });

  it('should handle a single-word full name', () => {
    const mapped = mapFieldData([{ name: 'full_name', values: ['Cher'] }]);

    expect(mapped.firstName).toBe('Cher');
    expect(mapped.lastName).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the mapper**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../map-field-data`.

```ts
// src/lib/leads/map-field-data.ts

export type MetaFieldDatum = { name: string; values: string[] };

export type MappedLead = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  companyName: string | null;
  // Every field as submitted, including form-specific custom questions,
  // so nothing is lost even when the mapping does not know a field.
  raw: Record<string, string>;
};

export const mapFieldData = (fieldData: MetaFieldDatum[]): MappedLead => {
  const raw: Record<string, string> = {};

  for (const datum of fieldData) {
    if (datum.values.length > 0) {
      raw[datum.name] = datum.values[0];
    }
  }

  const fullName = raw.full_name ?? '';
  const [derivedFirst, ...derivedRest] = fullName.split(' ');

  return {
    email: raw.email ?? null,
    firstName: raw.first_name ?? (fullName === '' ? null : derivedFirst),
    lastName: raw.last_name ?? (fullName === '' ? null : derivedRest.join(' ')),
    phone: raw.phone_number ?? null,
    companyName: raw.company_name ?? null,
    raw,
  };
};
```

- [ ] **Step 3: Write the lead fetcher**

```ts
// src/lib/leads/fetch-lead.ts
import { GRAPH_API_BASE } from '../publish/facebook/graph-api-version';
import { type MetaFieldDatum } from './map-field-data';

export type MetaLead = {
  id: string;
  created_time: string;
  ad_id?: string;
  form_id?: string;
  field_data: MetaFieldDatum[];
};

export const fetchLead = async (leadgenId: string, accessToken: string): Promise<MetaLead> => {
  const url = new URL(`${GRAPH_API_BASE}/${leadgenId}`);

  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Meta lead fetch failed with ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as MetaLead;

  return { ...payload, field_data: payload.field_data ?? [] };
};
```

- [ ] **Step 4: Write the failing ingestion test**

```ts
// src/logic-functions/__tests__/meta-ingest-lead.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, mutationMock, kvGetMock, fetchLeadMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
  kvGetMock: vi.fn(),
  fetchLeadMock: vi.fn(),
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

vi.mock('../../lib/leads/fetch-lead', () => ({ fetchLead: fetchLeadMock }));

import metaIngestLead from '../meta-ingest-lead.logic-function';

const handler = metaIngestLead.config.handler as (payload: {
  leadgenId: string;
  pageId: string;
  formId: string;
  createdTime: number;
}) => Promise<{ created: boolean; personId?: string }>;

const payload = { leadgenId: '123123', pageId: '111', formId: '555', createdTime: 1440120384 };

beforeEach(() => {
  vi.clearAllMocks();
  kvGetMock.mockResolvedValue('page-tok-1');
  fetchLeadMock.mockResolvedValue({
    id: '123123',
    created_time: '2026-08-07T09:00:00+0000',
    field_data: [
      { name: 'email', values: ['joe@example.com'] },
      { name: 'full_name', values: ['Joe Example'] },
    ],
  });
  queryMock.mockResolvedValue({ people: { edges: [] } });
  mutationMock.mockResolvedValue({ createPerson: { id: 'person-new' } });
});

describe('meta-ingest-lead handler', () => {
  it('should create a Person from the lead', async () => {
    const result = await handler(payload);

    expect(result.created).toBe(true);

    const data = mutationMock.mock.calls.find((call) => 'createPerson' in call[0])?.[0].createPerson
      .__args.data;

    expect(data.emails.primaryEmail).toBe('joe@example.com');
    expect(data.name).toEqual({ firstName: 'Joe', lastName: 'Example' });
  });

  it('should look the lead up with the stored page token', async () => {
    await handler(payload);

    expect(kvGetMock).toHaveBeenCalledWith('token:FACEBOOK:111');
    expect(fetchLeadMock).toHaveBeenCalledWith('123123', 'page-tok-1');
  });

  it('should be idempotent when the person already exists', async () => {
    queryMock.mockResolvedValue({ people: { edges: [{ node: { id: 'person-existing' } }] } });

    const result = await handler(payload);

    expect(result).toEqual({ created: false, personId: 'person-existing' });
    expect(mutationMock.mock.calls.some((call) => 'createPerson' in call[0])).toBe(false);
  });

  it('should throw when no page token is stored', async () => {
    kvGetMock.mockResolvedValue(null);

    await expect(handler(payload)).rejects.toThrow('No stored token for Facebook page 111');
  });

  it('should throw when the lead carries no email', async () => {
    fetchLeadMock.mockResolvedValue({
      id: '123123',
      created_time: '2026-08-07T09:00:00+0000',
      field_data: [{ name: 'full_name', values: ['Joe Example'] }],
    });

    await expect(handler(payload)).rejects.toThrow('Lead 123123 has no email');
  });
});
```

- [ ] **Step 5: Run it to verify it fails, then write the function**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../meta-ingest-lead.logic-function`.

```ts
// src/logic-functions/meta-ingest-lead.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { META_IDS } from '../constants/universal-identifiers';
import { getAccountToken } from '../lib/accounts/account-token-store';
import { fetchLead } from '../lib/leads/fetch-lead';
import { mapFieldData } from '../lib/leads/map-field-data';
import { SocialPlatform } from '../lib/publish/social-platform';

const handler = async (payload: {
  leadgenId: string;
  pageId: string;
  formId: string;
  createdTime: number;
}) => {
  const pageToken = await getAccountToken(SocialPlatform.FACEBOOK, payload.pageId);

  if (pageToken === null) {
    throw new Error(
      `No stored token for Facebook page ${payload.pageId}. Reconnect the Meta connection.`,
    );
  }

  const lead = await fetchLead(payload.leadgenId, pageToken);
  const mapped = mapFieldData(lead.field_data);

  if (mapped.email === null) {
    throw new Error(`Lead ${payload.leadgenId} has no email, cannot create a Person`);
  }

  const client = new CoreApiClient();

  // Email is the idempotency key. Meta redelivers webhooks, and the
  // resolver's 202 ack means a slow run can be redelivered mid-flight.
  const existing = (await client.query({
    people: {
      __args: { filter: { emails: { primaryEmail: { eq: mapped.email } } }, first: 1 },
      edges: { node: { id: true } },
    },
  })) as { people?: { edges?: { node: { id: string } }[] } };

  const existingId = existing.people?.edges?.[0]?.node.id;

  if (existingId) {
    return { created: false, personId: existingId };
  }

  const created = (await client.mutation({
    createPerson: {
      __args: {
        data: {
          name: { firstName: mapped.firstName ?? '', lastName: mapped.lastName ?? '' },
          emails: { primaryEmail: mapped.email, additionalEmails: [] },
          ...(mapped.phone
            ? {
                phones: {
                  primaryPhoneNumber: mapped.phone,
                  primaryPhoneCallingCode: '',
                  additionalPhones: [],
                },
              }
            : {}),
        },
      },
      id: true,
    },
  })) as { createPerson: { id: string } };

  return { created: true, personId: created.createPerson.id };
};

export default defineLogicFunction({
  universalIdentifier: META_IDS.ingestLead,
  name: 'meta-ingest-lead',
  description: 'Fetches a Meta Lead Ads submission and creates a Person from it.',
  timeoutSeconds: 60,
  handler,
});
```

The app role in the core grants no access to `person`. Add it before this runs:

```ts
// in src/roles/social.role.ts, inside objectPermissions
    {
      objectUniversalIdentifier: STANDARD_OBJECT.person,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
    },
```

with `import { STANDARD_OBJECT } from 'twenty-sdk/define';` at the top.

- [ ] **Step 6: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: ingest Meta Lead Ads submissions as People"
```

Expected: PASS, 11 new tests.

---

### Task 7: Wire it up against a real Page

**Files:** none. This is configuration and verification.

- [ ] **Step 1: Configure the Meta app**

At developers.facebook.com, on your app:

1. Add **Facebook Login** and **Webhooks** products.
2. Under Facebook Login → Settings, add the redirect URI Twenty shows in the app's connection section.
3. Note the App ID and App Secret.

- [ ] **Step 2: Fill in the server variables**

At **Settings → Admin Panel → Apps → Social**, set `META_APP_ID`, `META_APP_SECRET`, and invent a `META_WEBHOOK_VERIFY_TOKEN`.

- [ ] **Step 3: Connect and verify account discovery**

Connect the Meta account from the app's connections section, granting access to a Page you administer.

Expected: a **Social Account** record appears per Page, with `platform: FACEBOOK`, the Page id in `externalId`, `isActive` on, and `tokenExpiresAt` empty.

- [ ] **Step 4: Publish a real post**

Create a Social Post with a short body, status `SCHEDULED`, `scheduledAt` in the past, then:

```bash
yarn twenty dev:function:exec -n publish-due-posts -p '{}'
yarn twenty dev:function:logs
```

Expected: the target reaches `PUBLISHED` with a real `externalPostId` of the form `{page_id}_{post_id}`, and the post is visible on the Page.

If it fails with `(#200) Requires pages_manage_posts permission`, the app is in Development mode and the connecting user is not an app admin. Add them as an admin or complete App Review.

- [ ] **Step 5: Subscribe the webhook**

In the Meta app, Webhooks → Page → Subscribe to the `leadgen` field, with callback URL:

```
https://<your-twenty-server>/webhooks/server/<META_IDS.leadgenResolver>
```

and the verify token from Step 2.

Expected: Meta's verification GET succeeds immediately. If it fails, the app is not claimed and installed on its owner workspace, which a server route requires.

Then subscribe the Page itself to the app:

```bash
curl -X POST "https://graph.facebook.com/v25.0/{PAGE_ID}/subscribed_apps" \
  -d "subscribed_fields=leadgen" \
  -d "access_token={PAGE_TOKEN}"
```

- [ ] **Step 6: Test with a real lead**

Use Meta's Lead Ads Testing Tool to submit a test lead against your form.

Expected: within seconds, a **Person** record appears with the submitted email and name. Check `yarn twenty dev:function:logs` if not.

- [ ] **Step 7: Full check and commit**

```bash
yarn lint && yarn typecheck && yarn test:unit
git add -A && git commit -m "docs: record Meta app configuration steps"
```

---

## Definition of done

- All unit tests pass. 36 new tests across Tasks 2 to 6.
- Connecting Meta creates one `SocialAccount` per administered Page with a stored, non-expiring Page token.
- A scheduled Social Post publishes to a real Facebook Page and records the `{page_id}_{post_id}` identifier.
- A test lead submitted through Meta's Lead Ads Testing Tool becomes a Person within seconds.
- Replaying the same webhook payload twice creates exactly one Person.
- A payload with a tampered body is rejected with `invalid signature` and no Person is created.

## Known limitations, each a follow-up

- **One image per post.** Multi-photo needs the unpublished-photo then feed-attachment flow.
- **No video.** Video needs the resumable upload API.
- **No scheduling through Meta.** Posts publish immediately when the Twenty cron fires; Meta's own `scheduled_publish_time` is unused.
- **No lead-to-Company linking.** Only a Person is created. Matching `company_name` to a Company is a follow-up.
- **No `SocialMetric` collection.** Engagement pull is a separate plan.
