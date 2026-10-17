FROM node:22-alpine
WORKDIR /app

# Install dependencies first so Docker can cache this layer between code changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
# Apply migrations and seed data (both are safe to re-run), then start the API.
CMD ["sh", "-c", "npm run setup && npm start"]
