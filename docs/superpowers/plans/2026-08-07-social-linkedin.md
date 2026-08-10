# LinkedIn Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** `2026-08-07-social-core.md` must be complete. This plan is independent of the Facebook and Instagram plans.

**Goal:** Publish text and article posts to LinkedIn, as a member and, if partner access is granted, as an organization.

**Architecture:** A LinkedIn OAuth connection provider; an `onConnect` hook that resolves the member URN and any administered organization URNs into `SocialAccount` records; and one `SocialPublisher` posting to the versioned Posts API. Author URN is the only difference between member and organization posting, so a single adapter serves both.

**Tech Stack:** LinkedIn Posts API (versioned), `twenty-sdk`, Vitest 4.

## Global Constraints

- Every LinkedIn request carries three headers: `Authorization`, `X-Restli-Protocol-Version: 2.0.0`, and `LinkedIn-Version: YYYYMM`. Omitting any one returns an opaque 400.
- The API version is pinned in one constant. LinkedIn sunsets versions on a rolling schedule and a sunset version fails outright.
- The created post id comes back in the **`x-restli-id` response header**, not the body. The body is empty.
- Commentary limit is 3000 characters.
- Access tokens last 60 days. Refresh tokens exist but are themselves gated, so this plan surfaces expiry rather than silently refreshing.

## Read this before starting

LinkedIn is the hardest of the four platforms by a wide margin, and the outcome is not in your control.

| Capability | Scope | Availability |
|---|---|---|
| Post as the signed-in member | `w_member_social` | Generally obtainable |
| Post as a company page | `w_organization_social` | **Partner-gated.** Requires Community Management API access |
| List administered orgs | `r_organization_social` | Partner-gated, same programme |
| Read member's own posts | `r_member_social` | Restricted, approved users only |

Partner applications take **two to six months** and are frequently rejected without a stated reason.

**There is no legitimate API for automating personal profile activity, connection requests, or scraping.** LinkedIn enforces this aggressively, including litigation and permanent account bans. Nothing in this plan does any of that, and nothing should be added that does.

**Plan for organization posting not to happen.** Build member posting first, which works with the obtainable scope. If partner access never arrives, the fallback needs no code: mark the organization `SocialAccount` inactive and the core's fan-out skips it, leaving a human to publish company-page content by hand.

---

### Task 1: Connection provider and version constant

**Files:**
- Create: `src/lib/publish/linkedin/linkedin-version.ts`
- Create: `src/connection-providers/linkedin.connection-provider.ts`
- Modify: `src/application-config.ts`
- Modify: `src/constants/universal-identifiers.ts`

**Interfaces:**
- Produces: `LINKEDIN_API_BASE`, `LINKEDIN_VERSION`, and `LINKEDIN_IDS`.

- [ ] **Step 1: Generate UUIDs and extend the constants**

```bash
for i in $(seq 1 4); do uuidgen | tr '[:upper:]' '[:lower:]'; done
```

```ts
// append to src/constants/universal-identifiers.ts
export const LINKEDIN_IDS = {
  connectionProvider: 'REPLACE-L1',
  onConnect: 'REPLACE-L2',
  onDisconnect: 'REPLACE-L3',
} as const;
```

- [ ] **Step 2: Write the version constant**

```ts
// src/lib/publish/linkedin/linkedin-version.ts

// LinkedIn versions are YYYYMM and get sunset on a rolling schedule.
// Bumping this is a reviewed change: check the migration notes first at
// learn.microsoft.com/linkedin/marketing/integrations/migrations
export const LINKEDIN_VERSION = '202607';
export const LINKEDIN_API_BASE = 'https://api.linkedin.com/rest';
export const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
```

- [ ] **Step 3: Write the connection provider**

```ts
// src/connection-providers/linkedin.connection-provider.ts
import { defineConnectionProvider } from 'twenty-sdk/define';

import { LINKEDIN_IDS } from '../constants/universal-identifiers';

export default defineConnectionProvider({
  universalIdentifier: LINKEDIN_IDS.connectionProvider,
  name: 'linkedin',
  displayName: 'LinkedIn',
  type: 'oauth',
  oauthConfig: {
    authorizationEndpoint: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken',
    // openid and profile give /v2/userinfo, which is how the member URN
    // is resolved. The two organization scopes are requested optimistically:
    // LinkedIn simply omits what it has not approved.
    scopes: [
      'openid',
      'profile',
      'w_member_social',
      'w_organization_social',
      'r_organization_social',
    ],
    clientIdVariable: 'LINKEDIN_CLIENT_ID',
    clientSecretVariable: 'LINKEDIN_CLIENT_SECRET',
    tokenRequestContentType: 'form',
    usePkce: false,
  },
  onConnectLogicFunction: { universalIdentifier: LINKEDIN_IDS.onConnect },
  onDisconnectLogicFunction: { universalIdentifier: LINKEDIN_IDS.onDisconnect },
});
```

- [ ] **Step 4: Add the server variables**

```ts
// in src/application-config.ts, inside serverVariables
    LINKEDIN_CLIENT_ID: {
      description: 'LinkedIn app client ID from the LinkedIn Developer portal.',
      isSecret: false,
      isRequired: false,
    },
    LINKEDIN_CLIENT_SECRET: {
      description: 'LinkedIn app client secret.',
      isSecret: true,
      isRequired: false,
    },
```

- [ ] **Step 5: Sync and commit**

```bash
yarn twenty apply
git add -A && git commit -m "feat: add LinkedIn OAuth connection provider"
```

---

### Task 2: Identity resolution

**Files:**
- Create: `src/lib/publish/linkedin/linkedin-identity.ts`
- Test: `src/lib/publish/linkedin/__tests__/linkedin-identity.test.ts`

**Interfaces:**
- Produces: `fetchMemberUrn(accessToken)` and `listAdministeredOrganizations(accessToken)`. Task 3 calls both.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/linkedin/__tests__/linkedin-identity.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchMemberUrn, listAdministeredOrganizations } from '../linkedin-identity';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMemberUrn', () => {
  it('should build a person URN from the userinfo sub claim', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sub: 'abc123', name: 'Jane Doe' }),
    });

    expect(await fetchMemberUrn('tok')).toEqual({
      urn: 'urn:li:person:abc123',
      name: 'Jane Doe',
    });
  });

  it('should send the bearer token', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sub: 'abc123' }) });

    await fetchMemberUrn('tok');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('should fall back to the URN when the name is absent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sub: 'abc123' }) });

    expect((await fetchMemberUrn('tok')).name).toBe('urn:li:person:abc123');
  });

  it('should throw when userinfo fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'expired' });

    await expect(fetchMemberUrn('tok')).rejects.toThrow(
      'LinkedIn userinfo failed with 401: expired',
    );
  });
});

describe('listAdministeredOrganizations', () => {
  it('should return each approved administered organization URN', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [
          { organization: 'urn:li:organization:5515715', role: 'ADMINISTRATOR', state: 'APPROVED' },
          { organization: 'urn:li:organization:999', role: 'ADMINISTRATOR', state: 'APPROVED' },
        ],
      }),
    });

    expect(await listAdministeredOrganizations('tok')).toEqual([
      'urn:li:organization:5515715',
      'urn:li:organization:999',
    ]);
  });

  it('should send the versioned headers', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ elements: [] }) });

    await listAdministeredOrganizations('tok');

    const headers = fetchMock.mock.calls[0][1].headers;

    expect(headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(headers['LinkedIn-Version']).toMatch(/^\d{6}$/);
  });

  // Partner gating is the expected case, not an error.
  it('should return an empty array when the organization scope was not granted', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'ACCESS_DENIED' });

    expect(await listAdministeredOrganizations('tok')).toEqual([]);
  });

  it('should skip pending and rejected assignments', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [
          { organization: 'urn:li:organization:1', role: 'ADMINISTRATOR', state: 'REQUESTED' },
          { organization: 'urn:li:organization:2', role: 'ADMINISTRATOR', state: 'APPROVED' },
        ],
      }),
    });

    expect(await listAdministeredOrganizations('tok')).toEqual(['urn:li:organization:2']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../linkedin-identity`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/publish/linkedin/linkedin-identity.ts
import { LINKEDIN_API_BASE, LINKEDIN_USERINFO_URL, LINKEDIN_VERSION } from './linkedin-version';

export const linkedinHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  'X-Restli-Protocol-Version': '2.0.0',
  'LinkedIn-Version': LINKEDIN_VERSION,
});

export const fetchMemberUrn = async (
  accessToken: string,
): Promise<{ urn: string; name: string }> => {
  const response = await fetch(LINKEDIN_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`LinkedIn userinfo failed with ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as { sub: string; name?: string };
  const urn = `urn:li:person:${payload.sub}`;

  return { urn, name: payload.name ?? urn };
};

// Returns an empty array rather than throwing on 403. Organization access
// is partner-gated, and not having it is the expected state, not a fault.
export const listAdministeredOrganizations = async (
  accessToken: string,
): Promise<string[]> => {
  const url = `${LINKEDIN_API_BASE}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`;

  const response = await fetch(url, { headers: linkedinHeaders(accessToken) });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    elements?: { organization: string; state?: string }[];
  };

  return (payload.elements ?? [])
    .filter((element) => element.state === undefined || element.state === 'APPROVED')
    .map((element) => element.organization);
};
```

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add LinkedIn identity resolution"
```

Expected: PASS, 8 tests.

---

### Task 3: The onConnect hook

**Files:**
- Create: `src/logic-functions/linkedin-on-connect.logic-function.ts`
- Create: `src/logic-functions/linkedin-on-disconnect.logic-function.ts`
- Test: `src/logic-functions/__tests__/linkedin-on-connect.test.ts`

**Interfaces:**
- Consumes: Task 2's identity module, `setAccountToken` (core Task 6).
- Produces: `SocialAccount` records keyed by URN, with the member token stored under each URN.

The same member token authorises both member and organization posting, so it is stored once per URN.

- [ ] **Step 1: Write the failing test**

```ts
// src/logic-functions/__tests__/linkedin-on-connect.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, mutationMock, kvSetMock, getConnectionMock, memberMock, orgsMock } =
  vi.hoisted(() => ({
    queryMock: vi.fn(),
    mutationMock: vi.fn(),
    kvSetMock: vi.fn(),
    getConnectionMock: vi.fn(),
    memberMock: vi.fn(),
    orgsMock: vi.fn(),
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

vi.mock('../../lib/publish/linkedin/linkedin-identity', () => ({
  fetchMemberUrn: memberMock,
  listAdministeredOrganizations: orgsMock,
  linkedinHeaders: vi.fn(),
}));

import linkedinOnConnect from '../linkedin-on-connect.logic-function';

const handler = linkedinOnConnect.config.handler as (payload: {
  connectionId: string;
}) => Promise<{ accountsLinked: number }>;

const createdData = () =>
  mutationMock.mock.calls
    .filter((call) => 'createSocialAccount' in call[0])
    .map((call) => call[0].createSocialAccount.__args.data);

beforeEach(() => {
  vi.clearAllMocks();
  getConnectionMock.mockResolvedValue({ id: 'conn-1', accessToken: 'li-tok' });
  memberMock.mockResolvedValue({ urn: 'urn:li:person:abc', name: 'Jane Doe' });
  orgsMock.mockResolvedValue([]);
  queryMock.mockResolvedValue({ socialAccounts: { edges: [] } });
  mutationMock.mockResolvedValue({ createSocialAccount: { id: 'acct-new' } });
});

describe('linkedin-on-connect handler', () => {
  it('should create a member SocialAccount', async () => {
    const result = await handler({ connectionId: 'conn-1' });

    expect(result.accountsLinked).toBe(1);
    expect(createdData()[0]).toMatchObject({
      platform: 'LINKEDIN',
      externalId: 'urn:li:person:abc',
      handle: 'Jane Doe',
      isActive: true,
    });
  });

  it('should store the token under the member URN', async () => {
    await handler({ connectionId: 'conn-1' });

    expect(kvSetMock).toHaveBeenCalledWith('token:LINKEDIN:urn:li:person:abc', 'li-tok');
  });

  it('should set a 60 day expiry, since LinkedIn tokens are not auto-refreshed', async () => {
    await handler({ connectionId: 'conn-1' });

    expect(createdData()[0].tokenExpiresAt).toEqual(expect.any(String));
  });

  it('should create an account per administered organization', async () => {
    orgsMock.mockResolvedValue(['urn:li:organization:5515715']);

    const result = await handler({ connectionId: 'conn-1' });

    expect(result.accountsLinked).toBe(2);
    expect(createdData().map((data) => data.externalId)).toContain('urn:li:organization:5515715');
  });

  it('should store a token for each organization URN too', async () => {
    orgsMock.mockResolvedValue(['urn:li:organization:5515715']);

    await handler({ connectionId: 'conn-1' });

    expect(kvSetMock).toHaveBeenCalledWith(
      'token:LINKEDIN:urn:li:organization:5515715',
      'li-tok',
    );
  });

  it('should update rather than duplicate an existing account', async () => {
    queryMock.mockResolvedValue({
      socialAccounts: { edges: [{ node: { id: 'acct-existing' } }] },
    });

    await handler({ connectionId: 'conn-1' });

    expect(createdData()).toHaveLength(0);
    expect(
      mutationMock.mock.calls.find((call) => 'updateSocialAccount' in call[0])?.[0]
        .updateSocialAccount.__args.id,
    ).toBe('acct-existing');
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write the hook**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../linkedin-on-connect.logic-function`.

```ts
// src/logic-functions/linkedin-on-connect.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { getConnection } from 'twenty-sdk/logic-function';

import { LINKEDIN_IDS } from '../constants/universal-identifiers';
import { setAccountToken } from '../lib/accounts/account-token-store';
import {
  fetchMemberUrn,
  listAdministeredOrganizations,
} from '../lib/publish/linkedin/linkedin-identity';
import { SocialPlatform } from '../lib/publish/social-platform';

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

const handler = async (payload: { connectionId: string }) => {
  const connection = await getConnection(payload.connectionId);

  if (!connection) {
    throw new Error(`Connection ${payload.connectionId} not found`);
  }

  const accessToken = connection.accessToken;
  const member = await fetchMemberUrn(accessToken);
  const organizationUrns = await listAdministeredOrganizations(accessToken);

  const client = new CoreApiClient();
  // LinkedIn access tokens last 60 days and refresh tokens are gated,
  // so surface the deadline rather than pretend it renews.
  const tokenExpiresAt = new Date(Date.now() + SIXTY_DAYS_MS).toISOString();

  const upsert = async (urn: string, label: string) => {
    await setAccountToken(SocialPlatform.LINKEDIN, urn, accessToken);

    const existing = (await client.query({
      socialAccounts: {
        __args: {
          filter: { platform: { eq: 'LINKEDIN' }, externalId: { eq: urn } },
          first: 1,
        },
        edges: { node: { id: true } },
      },
    })) as { socialAccounts?: { edges?: { node: { id: string } }[] } };

    const data = {
      name: label,
      platform: 'LINKEDIN',
      externalId: urn,
      handle: label,
      isActive: true,
      connectedAt: new Date().toISOString(),
      tokenExpiresAt,
    };

    const existingId = existing.socialAccounts?.edges?.[0]?.node.id;

    if (existingId) {
      await client.mutation({
        updateSocialAccount: { __args: { id: existingId, data }, id: true },
      });
    } else {
      await client.mutation({ createSocialAccount: { __args: { data }, id: true } });
    }
  };

  await upsert(member.urn, member.name);

  for (const urn of organizationUrns) {
    await upsert(urn, urn);
  }

  return { accountsLinked: 1 + organizationUrns.length };
};

export default defineLogicFunction({
  universalIdentifier: LINKEDIN_IDS.onConnect,
  name: 'linkedin-on-connect',
  description:
    'Resolves the LinkedIn member URN and administered organization URNs into SocialAccounts.',
  timeoutSeconds: 60,
  handler,
});
```

- [ ] **Step 3: Write the disconnect hook**

```ts
// src/logic-functions/linkedin-on-disconnect.logic-function.ts
import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { LINKEDIN_IDS } from '../constants/universal-identifiers';

const handler = async () => {
  const client = new CoreApiClient();

  const accounts = (await client.query({
    socialAccounts: {
      __args: { filter: { platform: { eq: 'LINKEDIN' } }, first: 200 },
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
  universalIdentifier: LINKEDIN_IDS.onDisconnect,
  name: 'linkedin-on-disconnect',
  description: 'Deactivates LinkedIn SocialAccounts when the connection is removed.',
  timeoutSeconds: 60,
  handler,
});
```

- [ ] **Step 4: Run and commit**

```bash
yarn test:unit && git add -A && git commit -m "feat: add LinkedIn connect and disconnect hooks"
```

Expected: PASS, 6 tests.

---

### Task 4: The LinkedIn publisher

**Files:**
- Create: `src/lib/publish/linkedin/linkedin-publisher.ts`
- Modify: `src/lib/publish/publisher-registry.ts`
- Test: `src/lib/publish/linkedin/__tests__/linkedin-publisher.test.ts`

**Interfaces:**
- Consumes: `linkedinHeaders` (Task 2), `SocialPublisher` (core Task 4).
- Produces: `linkedinPublisher`, registered for `SocialPlatform.LINKEDIN`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/publish/linkedin/__tests__/linkedin-publisher.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { linkedinPublisher } from '../linkedin-publisher';

const fetchMock = vi.fn();

const input = {
  body: 'Hello from Twenty',
  mediaUrls: [] as string[],
  accountExternalId: 'urn:li:organization:5515715',
  accessToken: 'li-tok',
};

const okResponse = (postUrn = 'urn:li:share:6844785523593134080') => ({
  ok: true,
  status: 201,
  headers: { get: (name: string) => (name.toLowerCase() === 'x-restli-id' ? postUrn : null) },
  text: async () => '',
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('linkedinPublisher', () => {
  it('should declare the LINKEDIN platform and its limits', () => {
    expect(linkedinPublisher.platform).toBe('LINKEDIN');
    expect(linkedinPublisher.requiresMedia).toBe(false);
    expect(linkedinPublisher.maxBodyLength).toBe(3000);
  });

  it('should post to the versioned posts endpoint with all three headers', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await linkedinPublisher.publish(input);

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe('https://api.linkedin.com/rest/posts');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer li-tok');
    expect(init.headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(init.headers['LinkedIn-Version']).toMatch(/^\d{6}$/);
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('should send the documented post body shape', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await linkedinPublisher.publish(input);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      author: 'urn:li:organization:5515715',
      commentary: 'Hello from Twenty',
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('should read the post id from the x-restli-id response header', async () => {
    fetchMock.mockResolvedValue(okResponse('urn:li:share:999'));

    const result = await linkedinPublisher.publish(input);

    expect(result).toEqual({
      status: 'PUBLISHED',
      externalPostId: 'urn:li:share:999',
      permalink: 'https://www.linkedin.com/feed/update/urn:li:share:999/',
    });
  });

  it('should work identically for a person author', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await linkedinPublisher.publish({ ...input, accountExternalId: 'urn:li:person:abc' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).author).toBe('urn:li:person:abc');
  });

  it('should fail when the response header is missing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => '',
    });

    expect(await linkedinPublisher.publish(input)).toEqual({
      status: 'FAILED',
      error: 'LinkedIn accepted the post but returned no x-restli-id header',
    });
  });

  it('should surface a permission failure clearly', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => 'ACCESS_DENIED',
    });

    expect(await linkedinPublisher.publish(input)).toEqual({
      status: 'FAILED',
      error: 'LinkedIn rejected the post with 403: ACCESS_DENIED',
    });
  });

  it('should return FAILED rather than throw on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));

    expect(await linkedinPublisher.publish(input)).toEqual({
      status: 'FAILED',
      error: 'ETIMEDOUT',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn test:unit
```

Expected: FAIL, cannot resolve `../linkedin-publisher`.

- [ ] **Step 3: Write the adapter**

```ts
// src/lib/publish/linkedin/linkedin-publisher.ts
import { type PublishInput, type PublishResult, type SocialPublisher } from '../publisher.type';
import { SocialPlatform } from '../social-platform';
import { linkedinHeaders } from './linkedin-identity';
import { LINKEDIN_API_BASE } from './linkedin-version';

const MAX_COMMENTARY_LENGTH = 3000;

// Member and organization posting differ only in the author URN, which
// arrives as accountExternalId. One adapter serves both.
const publish = async (input: PublishInput): Promise<PublishResult> => {
  const body = {
    author: input.accountExternalId,
    commentary: input.body,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  try {
    const response = await fetch(`${LINKEDIN_API_BASE}/posts`, {
      method: 'POST',
      headers: { ...linkedinHeaders(input.accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return {
        status: 'FAILED',
        error: `LinkedIn rejected the post with ${response.status}: ${await response.text()}`,
      };
    }

    // The 201 body is empty; the id is only in this header.
    const externalPostId = response.headers.get('x-restli-id');

    if (externalPostId === null) {
      return {
        status: 'FAILED',
        error: 'LinkedIn accepted the post but returned no x-restli-id header',
      };
    }

    return {
      status: 'PUBLISHED',
      externalPostId,
      permalink: `https://www.linkedin.com/feed/update/${externalPostId}/`,
    };
  } catch (error) {
    return {
      status: 'FAILED',
      error: error instanceof Error ? error.message : 'LinkedIn publish failed',
    };
  }
};

export const linkedinPublisher: SocialPublisher = {
  platform: SocialPlatform.LINKEDIN,
  maxBodyLength: MAX_COMMENTARY_LENGTH,
  requiresMedia: false,
  publish,
};
```

Text-only posting. Images require uploading via the Images API to obtain a `urn:li:image:` URN first, which is a follow-up.

- [ ] **Step 4: Register it**

```ts
// in src/lib/publish/publisher-registry.ts
import { linkedinPublisher } from './linkedin/linkedin-publisher';

registerPublisher(linkedinPublisher);
```

- [ ] **Step 5: Run and commit**

```bash
yarn test:unit && yarn lint && git add -A && git commit -m "feat: add LinkedIn posts publisher"
```

Expected: PASS, 8 new tests.

---

### Task 5: Verify, and decide on organization posting

**Files:** none.

- [ ] **Step 1: Create the LinkedIn app**

At the LinkedIn Developer portal, create an app associated with a Company Page, add the **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** products, and note the client id and secret. Add the redirect URI Twenty shows in the app's connections section.

- [ ] **Step 2: Configure and connect**

Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` at **Settings → Admin Panel → Apps → Social**, then connect.

Expected: a Social Account with `externalId` of the form `urn:li:person:...`. If `w_organization_social` has not been granted, no organization account appears, which is the normal, expected outcome.

- [ ] **Step 3: Publish as a member**

Create a Social Post with a body under 3000 characters, `SCHEDULED`, `scheduledAt` in the past.

```bash
yarn twenty dev:function:exec -n publish-due-posts -p '{}'
yarn twenty dev:function:logs
```

Expected: the target reaches `PUBLISHED` with a `urn:li:share:...` id, and the post is live on the profile.

- [ ] **Step 4: Decide on organization posting**

If organization posting matters commercially, apply to the **Community Management API** partner programme now. It takes months.

Until then, if an organization Social Account exists but posting returns 403, set `isActive` to false on it. The core's fan-out skips inactive accounts, so company-page content simply stays a human task. No code change is needed for this fallback.

- [ ] **Step 5: Full check and commit**

```bash
yarn lint && yarn typecheck && yarn test:unit
git add -A && git commit -m "docs: record LinkedIn verification steps"
```

---

## Definition of done

- All unit tests pass. 22 new tests across Tasks 2 to 4.
- Connecting LinkedIn creates a member Social Account with the correct person URN.
- A scheduled post publishes to the member profile and records its share URN.
- A body over 3000 characters is rejected by the core validator before any API call.
- With organization scope ungranted, `listAdministeredOrganizations` returns empty and the connect flow still succeeds.

## Known limitations, each a follow-up

- **Text only.** Images need the Images API upload to get a `urn:li:image:` URN; video needs the Videos API.
- **No token refresh.** Tokens expire after 60 days and `tokenExpiresAt` records the deadline, but nothing warns or renews. A cron that flags accounts expiring within seven days is the obvious next step.
- **No organization posting until partner access lands.** The adapter already handles it; only the scope is missing.
- **No metrics.** Engagement retrieval needs `r_organization_social`, also partner-gated.
