# Use the official Node.js image
FROM node:22

# Set the working directory
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Expose port 3000 for the app
EXPOSE 3000

# Start the app
CMD ["node", "index.js"]
