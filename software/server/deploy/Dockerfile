FROM node:24.15.0-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund --no-audit
COPY server/src ./src
COPY web /app/web
RUN mkdir /data && chown node:node /data
USER node
ENV INSPECTION_CONFIG=/run/secrets/inspection_config
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.js"]
