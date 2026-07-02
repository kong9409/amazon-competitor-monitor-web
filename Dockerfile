FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-wqy-zenhei fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV REPORT_OUTPUT_DIR=/app/reports

EXPOSE 3000
CMD ["npm", "start"]
