FROM node:24-alpine AS dependencies
WORKDIR /app
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
RUN pnpm build

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM node:24-alpine AS frontend
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY docker/frontend.mjs ./docker/frontend.mjs
USER node
EXPOSE 8080
CMD ["node", "docker/frontend.mjs"]

FROM node:24-alpine AS backend
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY server ./server
COPY docker/backend.mjs ./docker/backend.mjs
RUN mkdir -p data && chown node:node data
USER node
VOLUME /app/data
EXPOSE 3018
CMD ["node", "docker/backend.mjs"]
