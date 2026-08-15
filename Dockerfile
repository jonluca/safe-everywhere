FROM node:24.13.1-bookworm-slim AS build

RUN npm install --global pnpm@11.22.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24.13.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data /config && chown node:node /data /config
USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start", "--config", "/config/chains.yaml"]
