FROM node:20-slim AS build

WORKDIR /app

COPY package*.json tsconfig.json ./
# --ignore-scripts: "prepare" runs tsc, which cannot work before sources are copied
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build

FROM node:20-slim

WORKDIR /app

COPY package*.json ./
# --ignore-scripts skips the "prepare" build; better-sqlite3 is native, so
# rebuild it explicitly to fetch or compile its binding for this image.
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3 && npm cache clean --force

COPY --from=build /app/dist ./dist

CMD ["node", "dist/index.js"]
