FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY services ./services
COPY packages ./packages
COPY pipelines ./pipelines
COPY data/sample ./data/sample
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/mcp-server ./services/mcp-server
COPY --from=build /app/packages ./packages
COPY --from=build /app/data/sample ./data/sample
USER node
EXPOSE 8787
CMD ["node", "services/mcp-server/dist/index.js", "--http"]

