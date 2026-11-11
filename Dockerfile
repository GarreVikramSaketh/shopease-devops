# ---------- Stage 1: install deps + run tests ----------
FROM node:20-alpine AS test
WORKDIR /app
COPY app/package*.json ./
RUN npm install --no-audit --no-fund
COPY app/ ./
RUN npm test

# ---------- Stage 2: production image ----------
FROM node:20-alpine AS production
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY app/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY app/server.js ./
COPY app/data ./data
COPY app/public ./public

# Build number gets baked in by Jenkins (also set again in the k8s manifest)
ARG BUILD_NUMBER=local
ENV BUILD_NUMBER=${BUILD_NUMBER}

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "server.js"]
