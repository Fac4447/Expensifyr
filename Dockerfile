FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy app source
COPY . .

# Create uploads directory
RUN mkdir -p uploads

EXPOSE 8080

CMD [ "node", "index.js" ]