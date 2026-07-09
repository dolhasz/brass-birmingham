FROM nginx:alpine

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js

ENV PORT=8080
EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
