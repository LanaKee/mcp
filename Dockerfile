FROM node:26-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY services ./services
COPY packages ./packages
COPY pipelines ./pipelines
COPY prototype ./prototype
COPY data/sample ./data/sample
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "!@gb/prototype" -r --sort --if-present run build
# 화면은 standalone으로 뽑는다. 컨테이너에는 저장소도 pnpm store도 없으므로
# 실제로 쓰는 모듈만 추려 자기 자신을 실행할 수 있는 한 벌이 필요하다.
RUN NEXT_STANDALONE=1 pnpm --filter @gb/prototype run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/services/mcp-server ./services/mcp-server
COPY --from=build /app/packages ./packages
COPY --from=build /app/data/sample ./data/sample
# standalone 출력은 저장소 뿌리를 그대로 재현한다. 진입점은
# prototype/server.js이고, 정적 자산은 추적 대상이 아니라 따로 얹어야 한다.
COPY --from=build /app/prototype/.next/standalone ./prototype-standalone
COPY --from=build /app/prototype/.next/static ./prototype-standalone/prototype/.next/static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
