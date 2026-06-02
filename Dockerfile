FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 7000

CMD ["node", "server.js"]
