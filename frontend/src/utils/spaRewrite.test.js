import fs from 'node:fs';
import path from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from 'vitest';

/**
 * infra/spa-rewrite.js is the CloudFront Function Terraform deploys (phase 6, G3). It has no
 * exports (CloudFront calls the global `handler`), so the file is evaluated as CloudFront
 * would run it.
 */
const source = fs.readFileSync(path.resolve(cwd(), '../infra/spa-rewrite.js'), 'utf8');
const handler = new Function(`${source}; return handler;`)();
const rewrite = (uri) => handler({ request: { uri, method: 'GET', headers: {}, querystring: {} } });

describe('CloudFront viewer-request function', () => {
  it.each(['/', '/projects', '/projects/5', '/users/', '/a/b/c', '/api/unknown'])(
    'serves index.html for %s (no file extension)', (uri) => {
      expect(rewrite(uri).uri).toBe('/index.html');
    },
  );

  it.each(['/index.html', '/favicon.svg', '/assets/index-Dx9ZOYMu.js', '/assets/app.css', '/robots.txt'])(
    'leaves the file %s alone', (uri) => {
      expect(rewrite(uri).uri).toBe(uri);
    },
  );

  it('only looks at the last path segment', () => {
    expect(rewrite('/v1.2/projects').uri).toBe('/index.html');
  });

  it('returns the request it was given, so the query string and headers pass through', () => {
    const request = { uri: '/projects/5', method: 'GET', headers: { host: { value: 'x' } }, querystring: { tab: { value: 'team' } } };
    const result = handler({ request });
    expect(result).toBe(request);
    expect(result.querystring).toEqual({ tab: { value: 'team' } });
  });

  it('uses only syntax the cloudfront-js-2.0 runtime has', () => {
    expect(source).toMatch(/^function handler\(event\) \{/m);
    expect(source).not.toMatch(/\b(import|export|require)\b/);
  });
});
