FROM docker.io/library/alpine:latest

ARG user

RUN apk add --no-cache nodejs-current npm
ENV HOME /tmp/home
RUN mkdir /tmp/home

COPY redeliver-failed-webhooks.mjs /tmp/home/
RUN chown -R $user /tmp/home

USER $user
WORKDIR /tmp/home

RUN npm install @octokit/core @octokit/plugin-paginate-rest
CMD ["node", "./redeliver-failed-webhooks.mjs"]
