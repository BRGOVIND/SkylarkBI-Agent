import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /**
   * Pin the workspace root to this project.
   *
   * A stray package.json in the parent directory made Next infer the root as
   * the user's home folder, which put the dev cache outside the project and let
   * it serve a previous build's stylesheet. Pinning it keeps the cache with the
   * code that produced it.
   */
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          /* Cross-origin framing stays blocked, which is the clickjacking
             threat; SAMEORIGIN additionally lets the app be framed by itself,
             which responsive QA relies on. frame-ancestors is the modern
             equivalent and takes precedence where supported. */
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
