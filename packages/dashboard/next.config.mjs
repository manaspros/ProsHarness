/** @type {import('next').NextConfig} */
const nextConfig = {
  // This is an internal, single-user operator console -- no need for image
  // optimization, i18n, etc. Keep the config minimal.
  reactStrictMode: true,
  eslint: {
    // No eslint config exists for this package yet, and the repo's linting
    // convention isn't established here -- don't block `next build` on it.
    ignoreDuringBuilds: true,
  },
  // better-sqlite3 is a native addon; ensure webpack/turbopack treat it as
  // an external in the server bundle rather than trying to bundle its .node
  // binary.
  serverExternalPackages: ["better-sqlite3"],
  webpack: (config) => {
    // Every @pros/* workspace package is written TypeScript-NodeNext style:
    // internal relative imports use a literal ".js" extension even though
    // the file on disk is ".ts" (tsc's NodeNext moduleResolution resolves
    // this by design). Webpack's own resolver has no built-in knowledge of
    // that convention -- without this, importing any @pros/* package here
    // fails with "Module not found: Can't resolve './journal.js'" etc, since
    // there is no dist/ build step for these workspace packages (main points
    // straight at ./src/index.ts). extensionAlias tells webpack "when asked
    // to resolve a .js specifier, also try .ts/.tsx first" -- resolving the
    // exact ambiguity NodeNext resolution is built around.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
