# syntax=docker/dockerfile:1.7

# ---- Stage 1: build ----
FROM node:22-alpine AS builder

WORKDIR /app

# Install full dependencies for the TypeScript build.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json biome.jsonc ./
COPY src ./src

RUN npm run build

# Re-install only production dependencies in a clean tree to copy into the
# runtime stage. This keeps the runtime image small (no devDependencies).
RUN npm prune --omit=dev


# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime

WORKDIR /app

# Use the built-in non-root `node` user (uid 1000) for the MCP server process.
COPY --from=builder --chown=node:node /app/build ./build
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node

# The token cache is written next to package.json (../.spotify-tokens relative
# to build/index.js, so /app/.spotify-tokens). Mount this path from the host.
ENTRYPOINT ["node", "/app/build/index.js"]
