import fs from 'node:fs';
import path from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, cspMetaPlugin } from './csp';

describe('Content-Security-Policy of the production build (phase 6, G1)', () => {
  it('is exactly the agreed policy', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
      + "font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
  });

  it('is injected as a meta tag at the top of the head', () => {
    const [tag] = cspMetaPlugin().transformIndexHtml('<html><head></head><body></body></html>');
    expect(tag).toEqual({
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
      injectTo: 'head-prepend',
    });
  });

  it('applies to production builds only, never to the dev server', () => {
    expect(cspMetaPlugin().apply).toBe('build');
  });

  it('is part of the Vite config', () => {
    // Read as text: loading the config itself would start esbuild inside the test environment.
    const config = fs.readFileSync(path.join(cwd(), 'vite.config.js'), 'utf8');
    expect(config).toMatch(/import \{ cspMetaPlugin \} from '\.\/csp';/);
    expect(config).toMatch(/plugins: \[react\(\), cspMetaPlugin\(\)\]/);
  });
});
