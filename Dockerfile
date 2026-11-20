# Hosting image for the game server (Railway, Render, Fly…). The Rust contract in programs/ is
# built and deployed separately with Anchor, so it isn't needed here.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]
