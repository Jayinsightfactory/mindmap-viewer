FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4747

CMD ["node", "--max-old-space-size=768", "--expose-gc", "server.js"]
