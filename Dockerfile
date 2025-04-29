# ---- Stage 1: Install dependencies ----
FROM node:20-slim AS deps
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy dependency definition files
COPY package.json pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm fetch --prod
RUN pnpm install --prod --frozen-lockfile --offline

# ---- Stage 2: Build application ----
FROM node:20-slim AS build
WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm

# Copy dependency definition files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including dev for building)
RUN pnpm fetch
RUN pnpm install --frozen-lockfile --offline

# Copy source code and config
COPY . .

# Build TypeScript
RUN pnpm build

# Remove dev dependencies after build
RUN pnpm prune --prod --no-optional

# ---- Stage 3: Production image ----
FROM node:20-slim AS production
WORKDIR /app

# Set NODE_ENV to production
ENV NODE_ENV=production
ENV PORT=3000

# Copy pruned production dependencies from build stage
COPY --from=build /app/node_modules ./node_modules
# Copy compiled code from build stage
COPY --from=build /app/dist ./dist
# Copy package.json (needed for start script) and potentially .env if not using secrets
COPY package.json .
# COPY .env . # Generally prefer secrets over including .env file

# Expose the application port
EXPOSE 3000

# Create a non-root user and switch to it
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs
USER nodejs

# Define the command to run the main web server
# Other processes (scheduler, worker) will be defined in fly.toml [processes]
CMD ["node", "dist/server.js"] 