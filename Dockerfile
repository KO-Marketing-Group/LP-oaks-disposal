FROM nginx:alpine
RUN apk add --no-cache nodejs npm

WORKDIR /app

# Install Node dependencies (includes devDeps for build-time minification)
COPY package.json ./
RUN npm install

# App code
COPY server.js ./
COPY scripts/ ./scripts/

# Nginx config + static site
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY style.css /usr/share/nginx/html/style.css
COPY robots.txt /usr/share/nginx/html/robots.txt
COPY ODS-FullColor-Logo.png /usr/share/nginx/html/
COPY ODS-Logo-Secondary-Bin.png /usr/share/nginx/html/
COPY Oaks-Square-200x200.svg /usr/share/nginx/html/
COPY garbagebin.png /usr/share/nginx/html/

# Minify CSS at build time
RUN npx lightningcss --minify /usr/share/nginx/html/style.css -o /usr/share/nginx/html/style.css

# Slim image — drop devDependencies after build-time minification
RUN npm prune --omit=dev

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
