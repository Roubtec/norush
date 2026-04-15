/**
 * Tests for sanitizeNextPath — the post-login redirect-target validator.
 *
 * The sanitizer is the only thing standing between a user-supplied query
 * parameter / cookie and a server-issued 302, so it gets exhaustive
 * coverage for both happy paths and known open-redirect tricks.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeNextPath } from '$lib/server/redirect';

describe('sanitizeNextPath', () => {
  describe('accepts safe internal paths', () => {
    it.each([
      ['/chat'],
      ['/dashboard'],
      ['/settings/limits'],
      ['/chat?id=123'],
      ['/chat?id=123&foo=bar'],
      ['/'],
    ])('accepts %s', (input) => {
      expect(sanitizeNextPath(input)).toBe(input);
    });

    it('strips fragment (the server never sees # anyway)', () => {
      expect(sanitizeNextPath('/chat#section')).toBe('/chat');
    });
  });

  describe('rejects empty / wrong-shape inputs', () => {
    it.each([
      [''],
      ['chat'],
      ['./chat'],
      ['../etc/passwd'],
      ['https://example.com/chat'],
      ['javascript:alert(1)'],
      ['mailto:a@b.com'],
    ])('rejects %s', (input) => {
      expect(sanitizeNextPath(input)).toBeNull();
    });

    it('rejects null / undefined / non-string', () => {
      expect(sanitizeNextPath(null)).toBeNull();
      expect(sanitizeNextPath(undefined)).toBeNull();
      expect(sanitizeNextPath(123 as unknown as string)).toBeNull();
    });
  });

  describe('blocks open-redirect tricks', () => {
    it.each([
      ['//evil.com/path'],
      ['//evil.com'],
      ['/\\evil.com'],
      ['/\\\\evil.com/path'],
      ['/path\\with-backslash'],
      ['/foo\\bar'],
    ])('rejects %s', (input) => {
      expect(sanitizeNextPath(input)).toBeNull();
    });

    it('rejects control characters', () => {
      expect(sanitizeNextPath('/chat\x00')).toBeNull();
      expect(sanitizeNextPath('/chat\nfoo')).toBeNull();
      expect(sanitizeNextPath('/chat\rfoo')).toBeNull();
    });
  });

  describe('blocks redirect loops', () => {
    it.each([
      ['/login'],
      ['/login?next=/chat'],
      ['/login/extra'],
      ['/auth/callback?code=abc'],
      ['/auth/logout'],
    ])('rejects %s', (input) => {
      expect(sanitizeNextPath(input)).toBeNull();
    });
  });

  describe('canonicalization', () => {
    it('collapses traversal that resolves inside origin', () => {
      // `new URL('/foo/../bar', base)` collapses to `/bar` — that's a safe
      // canonical form, so we accept it.
      expect(sanitizeNextPath('/foo/../bar')).toBe('/bar');
    });

    it('rejects traversal that would escape origin', () => {
      // Any input that would escape the origin gets caught by the
      // `parsed.origin !== DUMMY_ORIGIN` check or the explicit prefix
      // checks. Belt-and-braces.
      expect(sanitizeNextPath('//../foo')).toBeNull();
    });
  });
});
