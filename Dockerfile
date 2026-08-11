ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        g++ \
        gnupg \
        git \
        make \
        python3 \
    && curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/apt.llvm.org.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/apt.llvm.org.gpg] http://apt.llvm.org/bookworm/ llvm-toolchain-bookworm-18 main" \
        > /etc/apt/sources.list.d/llvm.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        clang-18 \
        libclang-rt-18-dev \
        llvm-18 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:native:pgo
RUN npm test
RUN npm run test:v8-http
RUN npm run test:v8-ws

FROM scratch AS prebuild

COPY --from=build /src/prebuilds/ /
