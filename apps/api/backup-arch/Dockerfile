FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json index.ts ./
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist/index.js ./index.js
COPY --from=build /app/node_modules ./node_modules
ENTRYPOINT ["node", "index.js"]