// Per-provider deviations from OAuth 2.0, keyed off the provider's own
// endpoints so an app manifest needs no extra fields and nothing has to be
// plumbed through metadata sync.
//
// Only TikTok deviates today. It names the client identifier `client_key`
// rather than `client_id` on both the authorize and token endpoints, and it
// separates scopes with commas rather than spaces. Sending the spec-compliant
// names gets "We couldn't log in with TikTok ... correct the following:
// client_key", which reads like a misconfigured app rather than a wrong
// parameter name.
//
// https://developers.tiktok.com/doc/login-kit-web

const TIKTOK_HOST_SUFFIXES = ['tiktok.com', 'tiktokapis.com'];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const isTikTokEndpoint = (url: string): boolean => {
  const host = hostOf(url);

  return TIKTOK_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
};

export const clientIdParamNameFor = (endpoint: string): string =>
  isTikTokEndpoint(endpoint) ? 'client_key' : 'client_id';

export const scopeSeparatorFor = (endpoint: string): string =>
  isTikTokEndpoint(endpoint) ? ',' : ' ';
