import {
  clientIdParamNameFor,
  scopeSeparatorFor,
} from 'src/engine/core-modules/application/connection-provider/utils/oauth-provider-quirks.util';

describe('oauth provider quirks', () => {
  describe('clientIdParamNameFor', () => {
    it('should use client_key for TikTok authorize and token endpoints', () => {
      expect(
        clientIdParamNameFor('https://www.tiktok.com/v2/auth/authorize/'),
      ).toBe('client_key');
      expect(
        clientIdParamNameFor('https://open.tiktokapis.com/v2/oauth/token/'),
      ).toBe('client_key');
    });

    it('should use client_id for everyone else', () => {
      expect(
        clientIdParamNameFor('https://graph.facebook.com/v21.0/oauth/access_token'),
      ).toBe('client_id');
      expect(
        clientIdParamNameFor('https://www.linkedin.com/oauth/v2/accessToken'),
      ).toBe('client_id');
    });

    it('should not be fooled by a lookalike host', () => {
      expect(clientIdParamNameFor('https://tiktok.com.evil.example/token')).toBe(
        'client_id',
      );
      expect(clientIdParamNameFor('https://nottiktok.com/token')).toBe(
        'client_id',
      );
    });

    it('should fall back to client_id for an unparseable endpoint', () => {
      expect(clientIdParamNameFor('not a url')).toBe('client_id');
    });
  });

  describe('scopeSeparatorFor', () => {
    it('should join TikTok scopes with commas', () => {
      expect(scopeSeparatorFor('https://www.tiktok.com/v2/auth/authorize/')).toBe(
        ',',
      );
    });

    it('should join every other provider with spaces', () => {
      expect(scopeSeparatorFor('https://www.linkedin.com/oauth/v2/authorization')).toBe(
        ' ',
      );
    });
  });
});
