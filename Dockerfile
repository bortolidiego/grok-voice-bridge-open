# Imagem leve para produção (Node.js 20 Alpine)
FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro para aproveitar cache de camadas.
COPY package*.json ./
RUN npm ci --only=production

# Copia código-fonte.
COPY src ./src

EXPOSE 8080 8830

USER node

CMD ["node", "src/entrypoint.js"]
