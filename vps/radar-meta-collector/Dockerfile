FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.mjs ./
ENV NODE_ENV=production
ENV PORT=8788
CMD ["node","server.mjs"]
