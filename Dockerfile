# Builds and runs the MCP server over stdio. Used by Glama.ai to run
# introspection (initialize / tools/list) and security checks against the
# server - no Garmin auth is required for that: tools answer with a
# re-auth message when no session exists.
FROM node:22-slim

# Must be set BEFORE `pnpm install` so puppeteer's postinstall does not try
# to download Chromium - this image never launches a browser, it only needs
# puppeteer to be importable (garmin-auth.ts imports it at module level;
# it's only launched inside authenticate(), which introspection never calls).
ENV PUPPETEER_SKIP_DOWNLOAD=1
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
ENV NODE_ENV=production

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

RUN pnpm prune --prod

CMD ["node", "dist/mcp-server.js"]
