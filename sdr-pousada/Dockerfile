FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ gcc && \
    npm ci --only=production && \
    apk del python3 make g++ gcc

COPY src/ ./src/
COPY public/ ./public/

EXPOSE 4000

CMD ["node", "src/server.js"]