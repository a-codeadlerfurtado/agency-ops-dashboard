# Backend da IA da Central de Operacoes - VPS Hostinger (EasyPanel/Docker Swarm).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Sem dependencias de build na imagem final.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# A imagem oficial ja' traz o usuario "node". Rodar como root aqui nao traria
# nenhuma vantagem e daria ao processo mais poder do que ele precisa.
USER node

ARG GIT_COMMIT=desconhecido
ENV GIT_COMMIT=$GIT_COMMIT
ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/ai/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
