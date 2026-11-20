FROM node:24-alpine AS build
ENV CI=true
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY docker/start.mjs ./docker/start.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
VOLUME /app/data
CMD ["node", "docker/start.mjs"]
