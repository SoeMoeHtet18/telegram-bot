# Use official Node.js LTS image
FROM node:22-slim

# Set working directory to root
WORKDIR /app

# Copy dependency files first
COPY package*.json ./

# === FIX: Clear npm state completely before install ===
RUN npm ci

# Copy source code
COPY . .

# Expose the application port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]