FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_COGNITO_USER_POOL_ID
ARG VITE_COGNITO_USER_POOL_CLIENT_ID
ARG VITE_COGNITO_REGION

ENV VITE_COGNITO_USER_POOL_ID=$VITE_COGNITO_USER_POOL_ID
ENV VITE_COGNITO_USER_POOL_CLIENT_ID=$VITE_COGNITO_USER_POOL_CLIENT_ID
ENV VITE_COGNITO_REGION=$VITE_COGNITO_REGION

RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
