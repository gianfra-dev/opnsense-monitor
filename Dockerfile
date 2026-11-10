FROM node:22-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TZ=Europe/Rome
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/status >/dev/null || exit 1
CMD ["node", "server.js"]
