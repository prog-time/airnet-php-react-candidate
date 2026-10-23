FROM php:7.4-cli-bullseye
# Debian 11 снят с поддержки: пакеты доступны только в archive.debian.org
RUN printf 'deb http://archive.debian.org/debian bullseye main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' > /etc/apt/sources.list && rm -f /etc/apt/sources.list.d/*
RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev && docker-php-ext-install pgsql && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PHP_CLI_SERVER_WORKERS=4
CMD ["php", "-d", "display_errors=0", "-S", "0.0.0.0:8080", "-t", "public", "public/router.php"]
