# ---- build stage (devDeps 포함, tsc 컴파일) ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage (prod deps만) ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
# 영속 데이터는 /app/data (배포 호스트에서 볼륨 마운트 + DB_PATH 지정 권장)
CMD ["node", "dist/index.js"]
