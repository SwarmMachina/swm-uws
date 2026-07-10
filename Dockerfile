ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        g++ \
        git \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:native
RUN npm test

FROM scratch AS prebuild

COPY --from=build /src/prebuilds/ /

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /src/lib ./lib
COPY --from=build /src/prebuilds ./prebuilds
COPY --from=build /src/test/smoke.js ./test/smoke.js

EXPOSE 3000

CMD ["node", "test/smoke.js", "--serve"]
