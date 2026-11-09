FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist
COPY src/supplier.wsdl ./dist/supplier.wsdl
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
