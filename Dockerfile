# Imagen del juego + monitoreo para Dokploy (o cualquier Docker)
FROM node:20-alpine

WORKDIR /app
COPY server.js index.html monitor.html ./
COPY qr/*.png ./qr/

# carpeta donde se guardan las estadísticas (montar un volumen aquí para no perderlas)
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
