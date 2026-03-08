FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data public/audio

EXPOSE 3456

CMD ["node", "server.js"]
